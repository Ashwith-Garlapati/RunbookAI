/**
 * Incident Domain - Shared Type Definitions (deterministic coordination layer).
 *
 * Branded string IDs keep Slack identifiers distinct from internal IDs.
 * No AI, no investigation logic — pure coordination bookkeeping.
 */

export type IncidentId = string;
export type OrganizationId = string;
export type TeamId = string;
export type SlackUserId = string;
export type SlackChannelId = string;
export type MessageTs = string;
export type ActionId = string;
export type FollowUpId = string;
export type UpdateId = string;
export type EscalationId = string;
export type TimelineEntryId = string;
export type ActivityEntryId = string;
export type IdempotencyKey = string;
