/**
 * Question Answering Service
 *
 * Answers @RunbookAI questions about the current Slack discussion or a
 * linked investigation. This is a CONTEXT-BUILDING flow, deliberately kept
 * separate from investigation creation:
 *
 *   - It NEVER creates an Investigation.
 *   - It NEVER routes through the Trigger Layer.
 *   - It only reads context and composes an answer.
 *
 * Answers are deterministic, Slack-friendly, and do not depend on an LLM.
 * A future AI Investigation Engine (services/aiEngine.ts) can be plugged in
 * HERE for richer answers - not in the trigger flow.
 */

import type { Investigation } from "../domains/investigation/Investigation.js";
import type { InvestigationService } from "../domains/investigation/InvestigationService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";

import { formatStatus } from "./formatStatus.js";

export interface QuestionAnswerResult {
  readonly answer: string;
  readonly investigationId?: string;
  readonly contextFound: boolean;
}

type QuestionType =
  | "summary"
  | "root_cause"
  | "changes"
  | "error"
  | "deploy"
  | "next_steps"
  | "status"
  | "generic";

const QUESTION_PATTERNS: Readonly<Array<{ type: QuestionType; pattern: RegExp }>> = [
  { type: "summary", pattern: /summarize|summary|recap|brief|what('s| is) (this|happening)|what happened/i },
  { type: "root_cause", pattern: /root cause|caused|cause|why (is|did|does)/i },
  { type: "changes", pattern: /changed today|what changed|deployments? today|recent changes/i },
  { type: "error", pattern: /error|exception|stack ?trace|explain/i },
  { type: "deploy", pattern: /who deployed|deployed|which (team|service) (deployed|pushed)/i },
  { type: "next_steps", pattern: /next|should we check|what do we do|next step/i },
  {
    type: "status",
    pattern:
      /status|where are we|progress|still (happening|ongoing|open)|resolved|resolved yet|fixed|done yet|who (resolved|closed|fixed)/i,
  },
];

export class QuestionAnsweringService {
  constructor(private readonly _investigationService: InvestigationService) {}

  /**
   * Answers a question using the current conversation context.
   *
   * @param params.question - the raw question text
   * @param params.channelId - the Slack channel the question was asked in
   * @param params.threadTs - thread the question was asked in (if any)
   */
  async answer(params: {
    question: string;
    channelId?: string;
    threadTs?: string;
  }): Promise<QuestionAnswerResult> {
    const question = params.question.trim();

    let investigation: Investigation | undefined;
    if (params.channelId) {
      investigation = await this._investigationService.findBySlackContext(
        params.channelId,
        params.threadTs,
      );
    }

    if (!investigation) {
      return {
        contextFound: false,
        answer: this.buildNoContextAnswer(question),
      };
    }

    const type = this.classify(question);
    const timeline = await this.safeTimeline(investigation.id);

    return {
      contextFound: true,
      investigationId: investigation.id,
      answer: this.buildAnswer(type, investigation, timeline),
    };
  }

  // ===========================
  //  Answer Building
  // ===========================

  private buildNoContextAnswer(question: string): string {
    const type = this.classify(question);

    if (type === "summary") {
      return (
        "I can't summarize this thread yet — I don't have a linked investigation here. " +
        "Use `@RunbookAI investigate <issue>` to start one, or run `/investigate <issue>`."
      );
    }

    return (
      "I couldn't find an active investigation linked to this conversation, so I have nothing to answer from yet.\n\n" +
      "To get started:\n" +
      "• `@RunbookAI investigate <issue>` — start an investigation\n" +
      "• `@RunbookAI help` — see everything I can do"
    );
  }

  private buildAnswer(
    type: QuestionType,
    investigation: Investigation,
    timeline: string[],
  ): string {
    switch (type) {
      case "summary":
        return this.buildSummary(investigation, timeline);
      case "root_cause":
        return this.buildRootCause(investigation, timeline);
      case "changes":
        return this.buildChanges(investigation);
      case "error":
        return this.buildError(investigation);
      case "deploy":
        return this.buildDeploy(investigation);
      case "next_steps":
        return this.buildNextSteps(investigation);
      case "status":
        return this.buildStatus(investigation, timeline);
      default:
        return this.buildSummary(investigation, timeline);
    }
  }

  private buildSummary(investigation: Investigation, timeline: string[]): string {
    const lines = [
      `*${investigation.title}*`,
      `Status: ${formatStatus(investigation.status)}`,
      `Description: ${investigation.description || "No description yet"}`,
    ];

    if (investigation.status === InvestigationStatus.Resolved) {
      lines.push(`Resolved by: <@${investigation.resolvedBy ?? "unknown"}>`);
    }
    if (investigation.reopenedAt) {
      lines.push(`Reopened by: <@${investigation.reopenedBy ?? "unknown"}>`);
    }

    if (timeline.length > 0) {
      lines.push(`Timeline (${timeline.length} events):`);
      lines.push(...timeline.slice(-5).map((entry) => `• ${entry}`));
    }

    lines.push(
      `Evidence collected: ${investigation.evidenceIds.length} — the Evidence Layer can collect the thread + GitHub context later.`,
    );

    return lines.join("\n");
  }

  private buildRootCause(investigation: Investigation, timeline: string[]): string {
    if (investigation.status === InvestigationStatus.Resolved) {
      return (
        `The investigation *${investigation.title}* is marked Resolved (by ${investigation.resolvedBy ?? "unknown"}).\n` +
        `Root cause was documented during the investigation:\n\n${this.formatTimeline(timeline)}`
      );
    }

    return (
      `Root cause is not confirmed yet for *${investigation.title}* (${formatStatus(investigation.status)}).\n` +
      `So far we know:\n• ${investigation.description || "no description recorded"}\n\n` +
      `I can't dig deeper until evidence (thread context, GitHub) is collected.`
    );
  }

  private buildChanges(investigation: Investigation): string {
    return (
      `I don't have change/deployment history yet for *${investigation.title}*.\n` +
      `Deploy and GitHub context will be collected by the Evidence Layer — ` +
      `nothing has been linked so far (0 evidence items).`
    );
  }

  private buildError(investigation: Investigation): string {
    return (
      `From the investigation *${investigation.title}*:\n\n` +
      `${investigation.description || "No error detail recorded yet."}\n\n` +
      `Want me to investigate this error properly? Reply with \`@RunbookAI investigate <summary>\`.`
    );
  }

  private buildDeploy(investigation: Investigation): string {
    return (
      `I can't see who deployed yet — GitHub/deploy context is not linked to *${investigation.title}*.\n` +
      `Once the Evidence Layer adds GitHub context, I can answer this.`
    );
  }

  private buildNextSteps(investigation: Investigation): string {
    const checklist: string[] = [
      `• Link the incident thread to *${investigation.title}* (mentions in this thread are linked already)`,
      "• Let the Evidence Layer collect Slack + GitHub context",
      "• Ask me to investigate specific errors: `@RunbookAI investigate <summary>`",
    ];

    if (investigation.status === InvestigationStatus.Resolved) {
      checklist.push("• Runbook generation can start now that the incident is Resolved");
    } else {
      checklist.push("• When it's fixed, say `@RunbookAI resolve this investigation`");
    }

    return `Here's what I'd check next for *${investigation.title}*:\n${checklist.join("\n")}`;
  }

  private buildStatus(investigation: Investigation, timeline: string[]): string {
    const lines = [
      `*${investigation.title}* is ${formatStatus(investigation.status)}.`,
    ];

    if (investigation.status === InvestigationStatus.Resolved) {
      const reopened = investigation.reopenedAt
        ? ` (reopened by ${investigation.reopenedBy ?? "unknown"} — see reopen timeline event)`
        : "";
      lines.push(`Resolved by <@${investigation.resolvedBy ?? "unknown"}>${reopened}.`);
    } else if (investigation.reopenedAt) {
      lines.push(`Reopened by <@${investigation.reopenedBy ?? "unknown"}> — work is active again.`);
    }

    lines.push(this.formatTimeline(timeline));
    return lines.join("\n");
  }

  // ===========================
  //  Helpers
  // ===========================

  private classify(question: string): QuestionType {
    const match = QUESTION_PATTERNS.find((entry) => entry.pattern.test(question));
    return match?.type ?? "generic";
  }

  private async safeTimeline(investigationId: string): Promise<string[]> {
    try {
      const events = await this._investigationService.getTimeline(investigationId);
      return events.map((event) => event.description);
    } catch {
      return [];
    }
  }

  private formatTimeline(timeline: string[]): string {
    if (timeline.length === 0) {
      return "Timeline: no events recorded yet.";
    }
    return `Timeline:\n${timeline.slice(-5).map((entry) => `• ${entry}`).join("\n")}`;
  }
}
