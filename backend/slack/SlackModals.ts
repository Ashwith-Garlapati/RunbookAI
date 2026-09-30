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

/**
 * Channel-style composer input (rich text: bold/italic/lists/mentions),
 * instead of a plain textarea. Values arrive as rich_text_value and must be
 * read with richTextToMarkdown(), never .value.
 */
export function richTextInput(actionId: string, placeholder: string, initial?: string): unknown {
  return {
    type: "rich_text_input",
    action_id: actionId,
    placeholder: { type: "plain_text", text: placeholder.slice(0, 150) },
    ...(initial ? { initial_value: plainToRich(initial.slice(0, 2000)) } : {}),
  };
}

function plainToRich(text: string): unknown {
  return {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  };
}

type RichNode = Record<string, unknown>;

function inlineMarkdown(node: RichNode): string {
  const type = String(node.type ?? "");
  if (type === "user" && typeof node.user_id === "string") return `<@${node.user_id}>`;
  if (type === "channel" && typeof node.channel_id === "string") return `<#${node.channel_id}>`;
  if (type === "emoji" && typeof node.name === "string") return `:${node.name}:`;
  if (type === "broadcast" && typeof node.range === "string") return `<!${node.range}>`;
  if (type === "link" && typeof node.url === "string") {
    const text = typeof node.text === "string" && node.text.length > 0 ? node.text : node.url;
    return `<${node.url}|${text}>`;
  }
  let text = typeof node.text === "string" ? node.text : "";
  const style = (node.style ?? {}) as RichNode;
  if (style.code === true) text = `\`${text}\``;
  else {
    if (style.bold === true) text = `*${text}*`;
    if (style.italic === true) text = `_${text}_`;
    if (style.strike === true) text = `~${text}~`;
  }
  return text;
}

function blockMarkdown(block: RichNode): string {
  const type = String(block.type ?? "");
  const elements = Array.isArray(block.elements) ? (block.elements as RichNode[]) : [];
  if (type === "rich_text_list") {
    const ordered = block.style === "ordered";
    return elements
      .map((el, i) => {
        const inner = Array.isArray((el as RichNode).elements)
          ? ((el as RichNode).elements as RichNode[]).map(inlineMarkdown).join("")
          : inlineMarkdown(el as RichNode);
        return `${ordered ? `${i + 1}.` : "•"} ${inner}`;
      })
      .join("\n");
  }
  if (type === "rich_text_quote") {
    return elements.map((el) => `> ${inlineMarkdown(el as RichNode)}`).join("");
  }
  if (type === "rich_text_preformatted") {
    return `\`\`\`${elements.map((el) => inlineMarkdown(el as RichNode)).join("")}\`\`\``;
  }
  return elements.map((el) => inlineMarkdown(el as RichNode)).join("");
}

/** Converts a submitted rich_text_value into Slack mrkdwn, preserving wording. */
export function richTextToMarkdown(value: unknown): string {
  if (typeof value === "string") return value;
  const root = (value ?? {}) as RichNode;
  const blocks = Array.isArray(root.elements) ? (root.elements as RichNode[]) : [];
  return blocks.map(blockMarkdown).join("\n").slice(0, 4000);
}

export const MODAL_CALLBACKS = {
  declare: "inc_modal_declare",
  update: "inc_modal_update",
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
      inputBlock("b_desc", "Description", richTextInput("desc", "What is happening?", initial?.description), true),
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
      inputBlock(
        "b_sev",
        "Severity",
        {
          type: "static_select",
          action_id: "severity",
          placeholder: plainText("Select severity"),
          options: [IncidentSeverity.Minor, IncidentSeverity.Major, IncidentSeverity.Critical].map((s) => ({
            text: plainText(SEVERITY_LABELS[s]),
            value: s,
          })),
        },
      ),
      inputBlock(
        "b_status",
        "Status",
        {
          type: "static_select",
          action_id: "status",
          placeholder: plainText("Select status"),
          options: [
            IncidentStatus.Investigating,
            IncidentStatus.Mitigating,
            IncidentStatus.Monitoring,
          ].map((s) => ({ text: plainText(incidentStatusLabel(s)), value: s })),
        },
      ),
      inputBlock("b_chg", "What changed", richTextInput("changed", "What is new?")),
      inputBlock(
        "b_next_in",
        "Next update in",
        {
          type: "static_select",
          action_id: "next_in",
          placeholder: plainText("No reminder"),
          options: [
            { text: plainText("10 minutes"), value: "10" },
            { text: plainText("15 minutes"), value: "15" },
            { text: plainText("30 minutes"), value: "30" },
            { text: plainText("1 hour"), value: "60" },
          ],
        },
        true,
      ),
    ],
  };
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
      inputBlock("b_desc", "Description", richTextInput("desc", "Details"), true),
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
      inputBlock("b_desc", "Description", richTextInput("desc", "Details"), true),
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
        type: "multi_users_select",
        action_id: "to_user",
        placeholder: plainText("Select people"),
      }),
      inputBlock("b_reason", "Reason", richTextInput("reason", "Why is this needed?")),
    ],
  };
}

export function handoverModal(incidentId: string): unknown {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACKS.handover,
    private_metadata: incidentId,
    title: plainText("Handover commander"),
    submit: plainText("Handover"),
    close: plainText("Cancel"),
    blocks: [
      inputBlock("b_user", "New commander", {
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
      inputBlock("b_summary", "Resolution summary", richTextInput("summary", "What stopped the incident?")),
      inputBlock("b_mitigation", "Mitigation", richTextInput("mitigation", "What fixed it?"), true),
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
    blocks: [inputBlock("b_reason", "Reason", richTextInput("reason", "Why is this not an incident?"))],
  };
}
