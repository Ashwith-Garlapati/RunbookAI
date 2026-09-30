/**
 * Slack - RunbookAI incident control message (own Block Kit design).
 *
 * Posted once per incident channel, then UPDATED in place on every relevant
 * mutation (severity/status/roles/actions/resolution). Buttons carry the
 * incident id; handlers re-validate auth + state server-side.
 */

import type { Incident } from "../domains/incident/Incident.js";
import { severityLabel } from "../domains/incident/IncidentSeverity.js";
import { ROLE_LABELS, IncidentRole } from "../domains/incident/IncidentRoles.js";
import { incidentStatusLabel } from "../domains/incident/IncidentStatus.js";

export const CONTROL_ACTIONS = {
  update: "inc_update",
  status: "inc_status",
  roles: "inc_roles",
  actions: "inc_actions",
  followups: "inc_followups",
  timeline: "inc_timeline",
  escalate: "inc_escalate",
  handover: "inc_handover",
  accept: "inc_accept",
  resolve: "inc_resolve",
  cancel: "inc_cancel",
  close: "inc_close",
} as const;

function roleLine(incident: Incident, role: IncidentRole): string {
  const assignee = incident.currentRoles[role];
  return `${ROLE_LABELS[role]}: ${assignee ? `<@${assignee}>` : "_vacant_"}`;
}

export function controlMessageText(incident: Incident): string {
  return `🚨 INCIDENT — ${incident.title} | ${severityLabel(incident.severity)} | ${incidentStatusLabel(incident.status)}`;
}

export function buildControlBlocks(incident: Incident): unknown[] {
  const openActions = incident.openActions().length;
  const openFollowUps = incident.openFollowUps().length;
  const commanderId = incident.currentRoles[IncidentRole.IncidentCommander] ?? null;
  const commanderState = incident.assignmentState(IncidentRole.IncidentCommander);
  const commanderLine =
    commanderId === null ? "_vacant_" : commanderState === "active" ? `<@${commanderId}> ✓` : `<@${commanderId}> (pending ack)`;
  const showAccept = commanderId !== null && commanderState === "pending_ack";
  return [
    { type: "header", text: { type: "plain_text", text: `🚨 ${incident.title.slice(0, 140)}`, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Severity:*\n${severityLabel(incident.severity)}` },
        { type: "mrkdwn", text: `*Status:*\n${incidentStatusLabel(incident.status)}` },
        { type: "mrkdwn", text: `*Commander:*\n${commanderLine}` },
        { type: "mrkdwn", text: `*Actions:*\n${openActions} open · ${openFollowUps} follow-ups` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          roleLine(incident, IncidentRole.IncidentCommander),
          `Started: <!date^${Math.floor(incident.createdAt.getTime() / 1000)}^{date_short} {time}|started>`,
        ].join("\n"),
      },
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Update", emoji: true }, action_id: CONTROL_ACTIONS.update, value: incident.id },
        { type: "button", text: { type: "plain_text", text: "Status", emoji: true }, action_id: CONTROL_ACTIONS.status, value: incident.id },
        { type: "button", text: { type: "plain_text", text: "Roles", emoji: true }, action_id: CONTROL_ACTIONS.roles, value: incident.id },
        { type: "button", text: { type: "plain_text", text: "Actions", emoji: true }, action_id: CONTROL_ACTIONS.actions, value: incident.id },
      ],
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Timeline", emoji: true }, action_id: CONTROL_ACTIONS.timeline, value: incident.id },
        { type: "button", text: { type: "plain_text", text: "Escalate", emoji: true }, action_id: CONTROL_ACTIONS.escalate, value: incident.id },
        { type: "button", text: { type: "plain_text", text: "Handover", emoji: true }, action_id: CONTROL_ACTIONS.handover, value: incident.id },
        {
          type: "button",
          text: { type: "plain_text", text: "Resolve", emoji: true },
          style: "primary",
          action_id: CONTROL_ACTIONS.resolve,
          value: incident.id,
        },
      ],
    },
    ...(showAccept
      ? [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Accept", emoji: true },
                style: "primary",
                action_id: CONTROL_ACTIONS.accept,
                value: incident.id,
              },
            ],
          },
        ]
      : []),
  ];
}

export function buildUpdateBlocks(params: { author: string; text: string }): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `📣 *Incident update* from <@${params.author}>` } },
    { type: "section", text: { type: "mrkdwn", text: params.text } },
  ];
}

export function buildTimelineBlocks(entries: Array<{ type: string; at: Date; summary: string }>): unknown[] {
  const lines = entries.slice(-20).map(
    (e) => `• \`[${e.type}]\` <!date^${Math.floor(e.at.getTime() / 1000)}^{date_short} {time}|${e.at.toISOString()}> — ${e.summary}`,
  );
  return [
    { type: "section", text: { type: "mrkdwn", text: "*Incident timeline (latest 20)*" } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") || "_No events yet_" } },
  ];
}

/** Read-only incident details for `/inc status` and the Status button. No mutations. */
export function buildIncidentDetailsBlocks(incident: Incident): unknown[] {
  const commanderId = incident.currentRoles[IncidentRole.IncidentCommander] ?? null;
  const commanderState = incident.assignmentState(IncidentRole.IncidentCommander);
  const roles = [
    commanderId === null
      ? null
      : `Commander: <@${commanderId}>${commanderState === "active" ? " ✓ Accepted" : " (awaiting acknowledgement)"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const resolutionLine = incident.resolution
    ? `Resolved by <@${incident.resolution.resolvedBy}> on <!date^${Math.floor(incident.resolution.resolvedAt.getTime() / 1000)}^{date_short} {time}|resolved>`
    : null;
  const lines = [
    roles || "No roles assigned yet",
    resolutionLine,
  ].filter(Boolean) as string[];
  return [
    { type: "header", text: { type: "plain_text", text: `📋 ${incident.title.slice(0, 140)}`, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Severity:* ${severityLabel(incident.severity)}` },
        { type: "mrkdwn", text: `*Status:* ${incidentStatusLabel(incident.status)}` },
        { type: "mrkdwn", text: `*Reporter:* <@${incident.reporterId}>` },
        { type: "mrkdwn", text: `*Channel:* ${incident.channelId ? `<#${incident.channelId}>` : "_none_"}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          ...lines,
          `Actions open: ${incident.openActions().length} · Follow-ups open: ${incident.openFollowUps().length} · Updates: ${incident.updates.length}`,
          `Service: ${incident.affectedService || "_unspecified_"}`,
          `Started: <!date^${Math.floor(incident.createdAt.getTime() / 1000)}^{date_short} {time}|started>`,
        ].join("\n"),
      },
    },
  ];
}
