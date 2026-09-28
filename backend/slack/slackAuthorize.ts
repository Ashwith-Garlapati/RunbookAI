/**
 * Slack - installation-backed authorize for Socket Mode.
 *
 * SocketModeReceiver delivers events over WebSocket, so Bolt cannot use the
 * HTTP installationStore flow per request. This authorize function resolves
 * the workspace bot token from Mongo (decrypting it) on every event.
 *
 * botId is required by Bolt's AuthorizeResult. It is stored at install time
 * (see Installation.model botId); rows installed before that field existed
 * fall back to a single cached `auth.test` lookup per workspace.
 */

import { WebClient } from "@slack/web-api";
import type { Authorize, AuthorizeResult, AuthorizeSourceData } from "@slack/bolt";

export interface InstallationRecord {
  readonly teamId: string;
  readonly teamName?: string;
  readonly botToken: string;
  readonly botUserId: string;
  readonly botId?: string | null;
}

export interface InstallationLookup {
  findByTeam(teamId: string): Promise<InstallationRecord | null>;
}

interface AuthTestClient {
  auth: {
    test(): Promise<{ bot_id?: unknown }>;
  };
}

export interface SlackAuthorizeDeps {
  readonly lookup: InstallationLookup;
  readonly decrypt: (stored: string) => string;
  readonly webClientFactory?: (botToken: string) => AuthTestClient;
}

export function createSlackAuthorize(deps: SlackAuthorizeDeps): Authorize<boolean> {
  const botIdCache = new Map<string, string>();

  return async ({ teamId }: AuthorizeSourceData<boolean>): Promise<AuthorizeResult> => {
    if (!teamId) {
      throw new Error("Missing teamId in authorize request");
    }
    const record = await deps.lookup.findByTeam(teamId);
    if (!record) {
      throw new Error(`Installation not found for team ${teamId}`);
    }
    const botToken = deps.decrypt(record.botToken);

    let botId = record.botId ?? botIdCache.get(teamId) ?? null;
    if (!botId) {
      const client = deps.webClientFactory ? deps.webClientFactory(botToken) : new WebClient(botToken);
      const auth = await client.auth.test();
      if (typeof auth.bot_id !== "string" || auth.bot_id.length === 0) {
        throw new Error(`Could not resolve bot id for team ${teamId}`);
      }
      botId = auth.bot_id;
      botIdCache.set(teamId, botId);
    }

    return {
      botToken,
      botId,
      botUserId: record.botUserId,
      teamId: record.teamId,
    };
  };
}
