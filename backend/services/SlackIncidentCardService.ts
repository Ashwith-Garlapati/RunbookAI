/**
 * Slack Incident Card Service
 *
 * Manages the persistent "investigation card" shown in Slack:
 *
 *   - postInvestigationCard(): post the card, optionally pin it
 *   - updateInvestigationCard(): keep the card in sync with investigation status
 *   - unpinInvestigationCard(): remove the pin once the runbook is published
 *
 * Pin policy (see SlackHandlers):
 *   - Slash command:             no card, no pin (clean investigation only)
 *   - Mention / shortcut:        card posted; pinned when the conversation is
 *                                used as the incident thread
 *   - Resolved + runbook done:   card unpinned (via SlackCardHandler)
 *
 * Only non-secret identifiers are passed to Slack: channel, ts, investigation
 * ID, status. Never tokens, response URLs, or auth headers.
 */

import { formatStatus } from "./formatStatus.js";

export interface SlackClientLike {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: unknown[];
    }): Promise<{ ts?: string }>;
    update(args: {
      channel: string;
      ts: string;
      text?: string;
      blocks?: unknown[];
    }): Promise<unknown>;
  };
  pins: {
    add(args: { channel: string; timestamp: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string }): Promise<unknown>;
  };
}

export interface PostCardParams {
  readonly channelId: string;
  readonly threadTs?: string;
  readonly title: string;
  readonly investigationId: string;
  readonly status: string;
  readonly pin: boolean;
}

export class SlackIncidentCardService {
  constructor(private readonly _client: SlackClientLike) {}

  /**
   * Posts an investigation card, optionally pinning it.
   * Returns the Slack message ts (needed for later updates/unpins).
   */
  async postInvestigationCard(params: PostCardParams): Promise<string | null> {
    const args: { channel: string; text: string; thread_ts?: string; blocks: unknown[] } = {
      channel: params.channelId,
      text: this.cardText(params),
      blocks: this.cardBlocks(params),
    };
    if (params.threadTs) {
      args.thread_ts = params.threadTs;
    }

    const result = await this._client.chat.postMessage(args);
    const ts = result.ts;
    if (!ts) {
      console.log("[SlackCard] Post failed | investigation=undefined | status=unknown");
      return null;
    }

    console.log(
      `[SlackCard] Posted | investigation=${params.investigationId} | status=${params.status} | pinned=${params.pin}`,
    );

    if (params.pin) {
      await this.pinCard(params.channelId, ts);
    }

    return ts;
  }

  /**
   * Updates an existing card with the current investigation status.
   */
  async updateInvestigationCard(params: {
    channelId: string;
    timestamp: string;
    title: string;
    investigationId: string;
    status: string;
  }): Promise<void> {
    await this._client.chat.update({
      channel: params.channelId,
      ts: params.timestamp,
      text: this.cardText(params),
      blocks: this.cardBlocks(params),
    });
    console.log(
      `[SlackCard] Updated | investigation=${params.investigationId} | status=${params.status}`,
    );
  }

  /**
   * Pins the investigation card in the incident thread/channel.
   */
  async pinCard(channelId: string, timestamp: string): Promise<void> {
    try {
      await this._client.pins.add({ channel: channelId, timestamp });
      console.log(`[SlackCard] Pinned | channel=${channelId} | ts=${timestamp}`);
    } catch (error) {
      // Pinning may be unsupported in some channels; the card still exists.
      console.log(`[SlackCard] Pin failed | channel=${channelId} | reason=${String(error)}`);
    }
  }

  /**
   * Unpins the incident card. Called after the incident is resolved and the
   * runbook has been generated/published (see handlers/SlackCardHandler.ts).
   */
  async unpinInvestigationCard(channelId: string, timestamp: string): Promise<void> {
    try {
      await this._client.pins.remove({ channel: channelId, timestamp });
      console.log(`[SlackCard] Unpinned | channel=${channelId} | ts=${timestamp}`);
    } catch (error) {
      console.log(`[SlackCard] Unpin failed | channel=${channelId} | reason=${String(error)}`);
    }
  }

  // ===========================
  //  Card Formatting
  // ===========================

  private cardText(params: { title: string; investigationId: string; status: string }): string {
    return `🚨 *${params.title}* (${params.investigationId}) — ${formatStatus(params.status)}`;
  }

  private cardBlocks(params: { title: string; investigationId: string; status: string }): unknown[] {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: "🚨 *Investigation Card*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Title:*\n${params.title}` },
          { type: "mrkdwn", text: `*ID:*\n${params.investigationId}` },
          { type: "mrkdwn", text: `*Status:*\n${formatStatus(params.status)}` },
        ],
      },
    ];
  }
}
