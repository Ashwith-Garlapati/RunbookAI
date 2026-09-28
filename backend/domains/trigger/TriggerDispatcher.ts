/**
 * Trigger Domain - Trigger Dispatcher
 *
 * Receives validated Triggers and dispatches them to InvestigationService.
 * The dispatcher is the final step in the trigger pipeline.
 *
 * Responsibilities:
 * - Receive Trigger
 * - Call InvestigationService.createInvestigation()
 * - Return Investigation ID
 * - Publish any trigger-related events if necessary
 *
 * `dispatch(trigger, { associate: true })` routes mention/shortcut triggers
 * through InvestigationService.createOrAssociateInvestigation() so existing
 * active investigations are reused instead of duplicated. The slash-command
 * path calls dispatch() WITHOUT the flag and always creates a clean
 * investigation.
 *
 * The dispatcher does NOT:
 * - Call AI
 * - Generate runbooks
 * - Manipulate Investigation state directly
 * - Access MongoDB directly
 * - Contain association business logic (that lives in InvestigationService)
 */

import type { Trigger } from "../investigation/Trigger.js";
import type { InvestigationService, InvestigationAcquisition } from "../investigation/InvestigationService.js";
import type { UserId } from "../investigation/types.js";
import type { ITriggerDispatcher, TriggerDispatchResult } from "./interfaces.js";

export class TriggerDispatcher implements ITriggerDispatcher {
  private readonly _investigationService: InvestigationService;

  constructor(investigationService: InvestigationService) {
    this._investigationService = investigationService;
  }

  /**
   * Dispatches a trigger to create (or reuse) an investigation.
   *
   * @param trigger - The validated Trigger object
   * @param options - When `associate` is true the trigger is matched against
   *                  existing active investigations via the conversation
   *                  context extracted from the trigger (used by mentions and
   *                  the shortcut). When false/omitted a clean investigation
   *                  is always created (used by slash commands).
   * @returns TriggerDispatchResult with the investigation ID
   */
  async dispatch(trigger: Trigger, options?: { associate?: boolean }): Promise<TriggerDispatchResult> {
    try {
      const acquisition = await this.acquire(trigger, options?.associate === true);

      const result: TriggerDispatchResult = {
        triggerId: trigger.id,
        triggerSource: trigger.source,
        triggerType: trigger.type,
        success: true,
        investigationId: "",
        status: "",
      };

      if (acquisition.kind === "needs_choice") {
        return {
          ...result,
          associated: false,
          association: "multiple",
          candidates: acquisition.candidates.map((candidate) => ({
            investigationId: candidate.id,
            title: candidate.title,
            status: candidate.status,
            createdAt: candidate.createdAt,
          })),
        };
      }

      const investigation = acquisition.investigation;
      return {
        ...result,
        investigationId: investigation.id,
        status: investigation.status,
        associated: acquisition.kind === "reused",
        association:
          acquisition.kind === "reused" ? acquisition.association : "created",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        investigationId: "",
        triggerId: trigger.id,
        status: "",
        triggerSource: trigger.source,
        triggerType: trigger.type,
        success: false,
        error: message,
      };
    }
  }

  /**
   * Acquires an investigation for the trigger, either by reusing an existing
   * active one (when association is requested) or by creating a new one.
   */
  private async acquire(
    trigger: Trigger,
    associate: boolean,
  ): Promise<InvestigationAcquisition> {
    const base = {
      title: this.extractTitle(trigger),
      description: this.extractDescription(trigger),
      severity: this.extractSeverity(trigger),
      trigger,
      createdBy: trigger.actor as UserId,
      metadata: this.buildMetadata(trigger),
    };

    if (!associate) {
      const investigation = await this._investigationService.createInvestigation(base);
      return { kind: "created", investigation };
    }

    return this._investigationService.createOrAssociateInvestigation({
      ...base,
      conversation: this.extractConversationContext(trigger),
    });
  }

  /**
   * Normalizes the Slack conversation context captured by the adapters into
   * canonical metadata keys (teamId / channelId / threadTs / rootMessageTs).
   * The canonical keys win over the raw adapter keys so every trigger that
   * carries Slack context is queryable for association.
   */
  private buildMetadata(trigger: Trigger): Record<string, unknown> {
    return {
      triggerSource: trigger.source,
      triggerType: trigger.type,
      ...trigger.metadata,
      ...this.extractConversationContext(trigger),
    };
  }

  /**
   * Extracts the Slack conversation context from a trigger payload/metadata
   * when it exists. Empty strings mean the field is unavailable.
   */
  private extractConversationContext(trigger: Trigger): {
    teamId: string;
    channelId: string;
    threadTs: string;
    rootMessageTs: string;
  } {
    const payload = trigger.payload;
    const metadata = trigger.metadata;
    return {
      teamId: String(metadata.slackTeamId ?? payload.teamId ?? ""),
      channelId: String(metadata.slackChannelId ?? payload.channel ?? ""),
      threadTs: String(metadata.threadTs ?? payload.threadTs ?? ""),
      rootMessageTs: String(metadata.messageTs ?? payload.messageTs ?? ""),
    };
  }

  /**
   * Extracts a title from the trigger payload.
   * Falls back to a default title based on source and type.
   */
  private extractTitle(trigger: Trigger): string {
    const payload = trigger.payload;

    // Check for explicit title in payload
    if (typeof payload.title === "string" && payload.title.trim().length > 0) {
      return payload.title;
    }

    // Check for text (common in Slack)
    if (typeof payload.text === "string" && payload.text.trim().length > 0) {
      const text = payload.text.trim();
      // Truncate long texts
      return text.length > 100 ? `${text.substring(0, 97)}...` : text;
    }

    // Check for mention message text (Slack @RunbookAI mentions)
    if (typeof payload.messageText === "string" && payload.messageText.trim().length > 0) {
      const text = payload.messageText.trim();
      return text.length > 100 ? `${text.substring(0, 97)}...` : text;
    }

    // Default title based on source and type
    return `Investigation from ${trigger.source} ${trigger.type}`;
  }

  /**
   * Extracts a description from the trigger payload.
   */
  private extractDescription(trigger: Trigger): string {
    const payload = trigger.payload;

    // Check for explicit description in payload
    if (typeof payload.description === "string" && payload.description.trim().length > 0) {
      return payload.description;
    }

    // Use text as description
    if (typeof payload.text === "string" && payload.text.trim().length > 0) {
      return payload.text.trim();
    }

    // Use mention message text as description
    if (typeof payload.messageText === "string" && payload.messageText.trim().length > 0) {
      return payload.messageText.trim();
    }

    // Default description
    return `Investigation triggered by ${trigger.actor} via ${trigger.source} ${trigger.type}`;
  }

  /**
   * Extracts severity from the trigger payload.
   * Defaults to "medium" if not specified.
   */
  private extractSeverity(trigger: Trigger): string {
    const payload = trigger.payload;

    if (typeof payload.severity === "string" && payload.severity.trim().length > 0) {
      return payload.severity.toLowerCase();
    }

    return "medium";
  }
}