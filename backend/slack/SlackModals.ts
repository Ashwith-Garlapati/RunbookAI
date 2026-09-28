/**
 * Slack - Block Kit modal builders for incident operations.
 *
 * Modals collect human input only. No AI inference, no rewriting —
 * user wording is preserved verbatim into updates/actions.
 */

import { IncidentSeverity, SEVERITY_LABELS } from "../domains/incident/IncidentSeverity.js";
import { IncidentStatus, incidentStatusLabel } from "../domains/incident/IncidentStatus.js";
import { INCIDENT_ROLES, ROLE_LABELS } from "../domains/incident/IncidentRoles.js";

function plainText(label: string): { type: "plain_text"; text: string; emoji: boolean } {
  return { type: "plain_text", text: label.slice(0, 24), emoji: true };
}

function inputBlock(blockId: string, label: string, element: unknown, optional = false): unknown {
  return { type: "input", block_id: blockId, label: plainText(label), element, optional };
}

function textInput(actionId: string, placeholder: string, multiline = false, initial?: string): unknown {
  return {
    type: "plain_text_input",
    action_id: actionId,
    placeholder: { type: "plain_text", text: placeholder.slice(0, 150) },
    multiline,
    ...(initial ? { initial_value: initial.slice(0, 2000) } : {}),
  };
}

export const MODAL_CALLBACKS = {
  declare: "inc_modal_declare",
  update: "inc_modal_update",
  severity: "inc_modal_severity",
  role: "inc_modal_role",
  action: "inc_modal_action",
  followup: "inc_modal_followup",
  escalate: "inc_modal_escalate",
  handover: "inc_modal_handover",
  resolve: "inc_modal_resolve",
  cancel: "inc_modal_cancel",
} as const;

export function declareModal(privateMetadata = "", initial?: { description?: string }): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.declare,
    private_metadata: privateMetadata,
    title: plainText("Declare incident"),
    submit: plainText("Declare"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_title", "Title", textInput("title", "Checkout API returning 500s")),
      inputBlock("b_desc", "Description", textInput("desc", "What is happening?", true, initial?.description), true),
      inputBlock("b_sev", "Severity", {
        type: "static_select",
        action_id: "severity",
        placeholder: plainText("Select severity"),
        options: [IncidentSeverity.Minor, IncidentSeverity.Major, IncidentSeverity.Critical].map((s) => ({
          text: plainText(SEVERITY_LABELS[s]),
          value: s,
        })),
      }),
      inputBlock("b_service", "Affected service", textInput("service", "checkout-api"), true),
    ],
  };
}

export function updateModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.update,
    private_metadata: incidentId,
    title: plainText("Post update"),
    submit: plainText("Post"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_sit", "Current situation", textInput("situation", "Where are we?", true)),
      inputBlock("b_chg", "What changed", textInput("changed", "What is new?", true)),
      inputBlock("b_imp", "Impact", textInput("impact", "Who is affected?", true)),
      inputBlock("b_next", "Next step", textInput("next", "What happens next?", true)),
      inputBlock(
        "b_sev",
        "Severity (optional)",
        {
          type: "static_select",
          action_id: "severity",
          placeholder: plainText("Keep current severity"),
          options: [IncidentSeverity.Minor, IncidentSeverity.Major, IncidentSeverity.Critical].map((s) => ({
            text: plainText(SEVERITY_LABELS[s]),
            value: s,
          })),
        },
        true,
      ),
      inputBlock(
        "b_status",
        "Status (optional)",
        {
          type: "static_select",
          action_id: "status",
          placeholder: plainText("Keep current status"),
          options: [
            IncidentStatus.Investigating,
            IncidentStatus.Mitigating,
            IncidentStatus.Monitoring,
          ].map((s) => ({ text: plainText(incidentStatusLabel(s)), value: s })),
        },
        true,
      ),
    ],
  };
}

export function severityModal(incidentId: string): unknown {
  const options = [IncidentSeverity.Minor, IncidentSeverity.Major, IncidentSeverity.Critical].map((s) => ({
    text: plainText(SEVERITY_LABELS[s]),
    value: s,
  }));
  return modalWithSelect(MODAL_CALLBACKS.severity, incidentId, "Change severity", "Severity", "severity", options);
}

export function roleModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.role,
    private_metadata: incidentId,
    title: plainText("Assign role"),
    submit: plainText("Assign"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_role", "Role", {
        type: "static_select",
        action_id: "role",
        placeholder: plainText("Select role"),
        options: INCIDENT_ROLES.map((r) => ({ text: plainText(ROLE_LABELS[r]), value: r })),
      }),
      inputBlock("b_user", "Assignee", {
        type: "users_select",
        action_id: "assignee",
        placeholder: plainText("Select person"),
      }),
    ],
  };
}

export function actionModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.action,
    private_metadata: incidentId,
    title: plainText("New action"),
    submit: plainText("Create"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_title", "Title", textInput("title", "Restart worker pool")),
      inputBlock("b_desc", "Description", textInput("desc", "Details", true), true),
      inputBlock("b_assignee", "Assignee", {
        type: "users_select",
        action_id: "assignee",
        placeholder: plainText("Select person"),
      }, true),
    ],
  };
}

export function followUpModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.followup,
    private_metadata: incidentId,
    title: plainText("New follow-up"),
    submit: plainText("Create"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_title", "Title", textInput("title", "Add pool-size alert")),
      inputBlock("b_desc", "Description", textInput("desc", "Details", true), true),
    ],
  };
}

export function escalateModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.escalate,
    private_metadata: incidentId,
    title: plainText("Escalate"),
    submit: plainText("Escalate"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_user", "Escalate to", {
        type: "users_select",
        action_id: "to_user",
        placeholder: plainText("Select person"),
      }),
      inputBlock("b_reason", "Reason", textInput("reason", "Why is this needed?", true)),
    ],
  };
}

export function handoverModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.handover,
    private_metadata: incidentId,
    title: plainText("Handover lead"),
    submit: plainText("Handover"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_user", "New incident lead", {
        type: "users_select",
        action_id: "new_commander",
        placeholder: plainText("Select person"),
      }),
    ],
  };
}

export function resolveModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.resolve,
    private_metadata: incidentId,
    title: plainText("Resolve incident"),
    submit: plainText("Resolve"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_summary", "Resolution summary", textInput("summary", "What stopped the incident?", true)),
      inputBlock("b_mitigation", "Mitigation", textInput("mitigation", "What fixed it?", true), true),
    ],
  };
}

export function cancelModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.cancel,
    private_metadata: incidentId,
    title: plainText("Cancel incident"),
    submit: plainText("Cancel incident"),
    close: plainText("Back"),
    blocks: [inputBlock("b_reason", "Reason", textInput("reason", "Why is this not an incident?", true))],
  };
}

function modalWithSelect(
  callbackId: string,
  incidentId: string,
  title: string,
  label: string,
  actionId: string,
  options: Array<{ text: unknown; value: string }>,
): unknown {
  return {
    type: "modal",
    callback_id: callbackId,
    private_metadata: incidentId,
    title: plainText(title),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_value", label, {
        type: "static_select",
        action_id: actionId,
        placeholder: plainText(`Select ${label.toLowerCase()}`),
        options,
      }),
    ],
  };
}
