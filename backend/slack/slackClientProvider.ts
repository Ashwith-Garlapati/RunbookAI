/**
 * Slack - per-workspace authorized API clients.
 *
 * `bolt.client` at startup carries NO token when a custom `authorize` is
 * used (Socket Mode). Any API call made with it fails with `not_authed`.
 * Background jobs and event-driven handlers (no per-event client in scope)
 * MUST resolve a team client here instead: token looked up from the
 * installation store, decrypted, cached per workspace.
 */

import { WebClient } from "@slack/web-api";

import type { InstallationLookup } from "./slackAuthorize.js";
import type { TeamId } from "../domains/incident/types.js";

export interface SlackClientProvider {
  forTeam(teamId: TeamId): Promise<WebClient>;
}

export interface SlackClientProviderDeps {
  readonly lookup: InstallationLookup;
  readonly decrypt: (stored: string) => string;
}

export function createSlackClientProvider(deps: SlackClientProviderDeps): SlackClientProvider {
  const cache = new Map<string, WebClient>();
  return {
    forTeam: async (teamId: TeamId): Promise<WebClient> => {
      const hit = cache.get(teamId);
      if (hit) return hit;
      const record = await deps.lookup.findByTeam(teamId);
      if (!record) {
        throw new Error(`Installation not found for team ${teamId}`);
      }
      const client = new WebClient(deps.decrypt(record.botToken));
      cache.set(teamId, client);
      return client;
    },
  };
}
