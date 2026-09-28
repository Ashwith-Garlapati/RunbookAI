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
  severity: "inc_severity",
  roles: "inc_roles",
  actions: "inc_actions",
  followups: "inc_followups",
  timeline: "inc_timeline",
  escalate: "inc_escalate",
  handover: "inc_handover",
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
  return [
    { type: "header", text: { type: "plain_text", text: `🚨 ${incident.title.slice(0, 140)}`, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Severity:*\n${severityLabel(incident.severity)}` },
        { type: "mrkdwn", text: `*Status:*\n${incidentStatusLabel(incident.status)}` },
        { type: "mrkdwn", text: `*Lead:*\n${incident.currentRoles.incident_lead ? `<@${incident.currentRoles.incident_lead}>` : "_vacant_"}` },
        { type: "mrkdwn", text: `*Actions:*\n${openActions} open · ${openFollowUps} follow-ups` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          roleLine(incident, IncidentRole.IncidentLead),
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
        { type: "button", text: { type: "plain_text", text: "Severity", emoji: true }, action_id: CONTROL_ACTIONS.severity, value: incident.id },
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
  ];
}

export function buildUpdateBlocks(params: {
  author: string;
  situation: string;
  changed: string;
  impact: string;
  nextStep: string;
}): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `📣 *Incident update* from <@${params.author}>` } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Situation:*\n${params.situation}\n*What changed:*\n${params.changed}\n*Impact:*\n${params.impact}\n*Next step:*\n${params.nextStep}`,
      },
    },
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
  const roles = [incident.currentRoles.incident_lead ? `Lead: <@${incident.currentRoles.incident_lead}>` : null]
    .filter(Boolean)
    .join(" · ");
  return [
    { type: "header", text: { type: "plain_text", text: `📋 ${incident.title.slice(0, 140)}`, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Severity:*\n${severityLabel(incident.severity)}` },
        { type: "mrkdwn", text: `*Status:*\n${incidentStatusLabel(incident.status)}` },
        { type: "mrkdwn", text: `*Reporter:*\n<@${incident.reporterId}>` },
        { type: "mrkdwn", text: `*Channel:*\n${incident.channelId ? `<#${incident.channelId}>` : "_none_"}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          roles || "No roles assigned yet",
          `Actions open: ${incident.openActions().length} · Follow-ups open: ${incident.openFollowUps().length} · Updates: ${incident.updates.length}`,
          `Service: ${incident.affectedService || "_unspecified_"}`,
          `Started: <!date^${Math.floor(incident.createdAt.getTime() / 1000)}^{date_short} {time}|started>`,
        ].join("\n"),
      },
    },
  ];
}
