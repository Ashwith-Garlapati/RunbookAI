/**
 * Slack - incident channel management (deterministic, idempotent).
 *
 * Identity is ALWAYS the Slack channel ID + internal incident ID.
 * Channel names are display-only. Invitation failures are isolated per user.
 */

import { logger } from "../observability/logger.js";

export interface ChannelClientLike {
  conversations: {
    create(args: { name: string; is_private?: boolean }): Promise<{ channel?: { id?: string; name?: string } }>;
    invite(args: { channel: string; users: string }): Promise<unknown>;
    info(args: { channel: string }): Promise<{ channel?: { id?: string; name?: string } }>;
  };
  chat: {
    getPermalink(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }>;
  };
}

/** Deterministic channel name: inc-<slug>-<MMDD>-<rand4> (Slack allows lowercase, -, _). */
export function buildChannelName(title: string, now = new Date(), randSuffix?: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "incident";
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const rand = (randSuffix ?? Math.random().toString(36).slice(2, 6)).toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 4).padEnd(4, "0");
  return `inc-${slug}-${mm}${dd}-${rand}`.slice(0, 80);
}

export class SlackChannelManager {
  constructor(private readonly _client: ChannelClientLike) {}

  async createIncidentChannel(params: {
    title: string;
    correlationId: string;
    isPrivate?: boolean;
  }): Promise<{ channelId: string; channelName: string }> {
    const name = buildChannelName(params.title);
    try {
      const result = await this._client.conversations.create({ name, is_private: params.isPrivate ?? false });
      const channelId = result.channel?.id;
      if (!channelId) throw new Error("Slack did not return a channel id");
      logger.info("ChannelManager", "ChannelCreated", {
        correlationId: params.correlationId,
        channelName: result.channel?.name ?? name,
      });
      return { channelId, channelName: result.channel?.name ?? name };
    } catch (error: unknown) {
      if (error instanceof Error && /name_taken/i.test(error.message)) {
        const retry = `${name}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 80);
        const result = await this._client.conversations.create({ name: retry, is_private: params.isPrivate ?? false });
        const channelId = result.channel?.id;
        if (!channelId) throw new Error("Slack did not return a channel id");
        return { channelId, channelName: result.channel?.name ?? retry };
      }
      throw error;
    }
  }

  /** Invites responders; each failure is logged and isolated (never fatal). */
  async inviteResponders(channelId: string, userIds: string[], correlationId: string): Promise<{ invited: string[]; failed: string[] }> {
    const invited: string[] = [];
    const failed: string[] = [];
    for (const userId of userIds) {
      try {
        await this._client.conversations.invite({ channel: channelId, users: userId });
        invited.push(userId);
      } catch (error) {
        failed.push(userId);
        logger.warn("ChannelManager", "InviteFailed", {
          correlationId,
          channelId,
          userId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { invited, failed };
  }

  async getPermalink(channelId: string, messageTs: string): Promise<string | null> {
    try {
      const result = await this._client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
      return result.permalink ?? null;
    } catch {
      return null;
    }
  }
}
