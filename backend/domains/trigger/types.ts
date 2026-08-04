/**
 * Trigger Domain - Type Definitions
 *
 * Types specific to the Trigger Layer pipeline.
 */

import type { TriggerSource } from "../investigation/TriggerSource.js";
import type { TriggerType } from "../investigation/TriggerType.js";

/**
 * Raw event data coming from an external system.
 * Adapters convert this into a normalized Trigger.
 */
export type RawSlackEvent = {
  type: string;
  team_id?: string;
  user_id?: string;
  user_name?: string;
  channel_id?: string;
  channel_name?: string;
  text?: string;
  trigger_id?: string;
  action_ts?: string;
  message_ts?: string;
  thread_ts?: string;
  callback_id?: string;
  api_app_id?: string;
  token?: string;
  response_url?: string;
  [key: string]: unknown;
};

/**
 * Supported trigger sources in the Trigger Layer.
 */
export type TriggerLayerSource = TriggerSource.Slack;

/**
 * Supported trigger types in the Trigger Layer.
 */
export type TriggerLayerType =
  | TriggerType.SlashCommand
  | TriggerType.MessageShortcut
  | TriggerType.Mention;

/**
 * Validation error for trigger creation.
 */
export class TriggerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerValidationError";
  }
}
