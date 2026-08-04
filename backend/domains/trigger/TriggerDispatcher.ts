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
 * The dispatcher does NOT:
 * - Call AI
 * - Generate runbooks
 * - Manipulate Investigation state directly
 * - Access MongoDB directly
 */

import type { Trigger } from "../investigation/Trigger.js";
import type { InvestigationService } from "../investigation/InvestigationService.js";
import type { UserId } from "../investigation/types.js";
import type { ITriggerDispatcher, TriggerDispatchResult } from "./interfaces.js";

export class TriggerDispatcher implements ITriggerDispatcher {
  private readonly _investigationService: InvestigationService;

  constructor(investigationService: InvestigationService) {
    this._investigationService = investigationService;
  }

  /**
   * Dispatches a trigger to create an investigation.
   *
   * @param trigger - The validated Trigger object
   * @returns TriggerDispatchResult with the investigation ID
   */
  async dispatch(trigger: Trigger): Promise<TriggerDispatchResult> {
    try {
      const investigation = await this._investigationService.createInvestigation({
        title: this.extractTitle(trigger),
        description: this.extractDescription(trigger),
        severity: this.extractSeverity(trigger),
        trigger,
        createdBy: trigger.actor as UserId,
        metadata: {
          triggerSource: trigger.source,
          triggerType: trigger.type,
          ...trigger.metadata,
        },
      });

      return {
        investigationId: investigation.id,
        triggerId: trigger.id,
        status: investigation.status,
        triggerSource: trigger.source,
        triggerType: trigger.type,
        success: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        investigationId: "" as any,
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
