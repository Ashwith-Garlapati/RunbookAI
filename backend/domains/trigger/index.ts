/**
 * Trigger Domain - Barrel Exports
 *
 * Single import point for the entire Trigger Layer.
 * Consumers should import from this module:
 *
 *   import { TriggerDispatcher, TriggerFactory, TriggerRegistry } from "./domains/trigger/index.js";
 */

// --- Core Types & Interfaces ---
export type {
  ITriggerAdapter,
  ITriggerValidator,
  ITriggerFactory,
  ITriggerDispatcher,
  ITriggerRegistry,
  TriggerDispatchResult,
} from "./interfaces.js";

export type { RawSlackEvent, TriggerLayerSource, TriggerLayerType } from "./types.js";
export { TriggerValidationError } from "./types.js";

// --- Core Components ---
export { TriggerValidator } from "./TriggerValidator.js";
export { TriggerFactory } from "./TriggerFactory.js";
export { TriggerDispatcher } from "./TriggerDispatcher.js";
export { TriggerRegistry } from "./TriggerRegistry.js";

// --- Slack Adapters ---
export { SlackSlashCommandAdapter } from "./adapters/SlackSlashCommandAdapter.js";
export { SlackShortcutAdapter } from "./adapters/SlackShortcutAdapter.js";
export { SlackMentionAdapter } from "./adapters/SlackMentionAdapter.js";
