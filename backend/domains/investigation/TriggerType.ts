/**
 * Investigation Domain - Trigger Type Enum
 *
 * Specifies the mechanism by which a trigger was initiated within a source.
 * For example, Slack supports slash commands and message shortcuts.
 */

export enum TriggerType {
  SlashCommand = "slash_command",
  MessageShortcut = "message_shortcut",
  Mention = "mention",
  Webhook = "webhook",
  Alert = "alert",
  ManualAPI = "manual_api",
  ManualUI = "manual_ui",
  ScheduledScan = "scheduled_scan",
}
