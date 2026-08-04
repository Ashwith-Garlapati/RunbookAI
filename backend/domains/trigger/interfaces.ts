/**
 * Trigger Domain - Interfaces
 *
 * Core contracts for the Trigger Layer.
 * These interfaces define the pipeline that all triggers must follow.
 */

import type { Trigger } from "../investigation/Trigger.js";
import type { InvestigationId, TriggerId } from "../investigation/types.js";

/**
 * Result of dispatching a trigger to create an investigation.
 */
export interface TriggerDispatchResult {
  readonly investigationId: InvestigationId;
  readonly triggerId: TriggerId;
  readonly status: string;
  readonly triggerSource: string;
  readonly triggerType: string;
  readonly success: boolean;
  readonly error?: string;
}

/**
 * Interface for adapters that convert external events into Triggers.
 * Each external system (Slack, GitHub, etc.) implements one or more adapters.
 */
export interface ITriggerAdapter {
  readonly source: string;
  readonly type: string;

  /**
   * Converts raw external event data into a normalized Trigger object.
   * Returns null if the event cannot be converted (e.g., missing required fields).
   */
  adapt(rawEvent: unknown): Trigger | null;
}

/**
 * Interface for the TriggerValidator.
 * Validates that a Trigger has all required fields and valid values.
 */
export interface ITriggerValidator {
  /**
   * Validates a trigger object. Returns true if valid, throws if invalid.
   */
  validate(trigger: unknown): trigger is Trigger;
}

/**
 * Interface for the TriggerFactory.
 * Creates Trigger objects from validated adapter outputs.
 */
export interface ITriggerFactory {
  /**
   * Creates a Trigger from raw external event data.
   * Uses the appropriate adapter based on the event type.
   */
  create(adapter: ITriggerAdapter, rawEvent: unknown): Trigger;
}

/**
 * Interface for the TriggerDispatcher.
 * Receives validated Triggers and dispatches them to InvestigationService.
 */
export interface ITriggerDispatcher {
  /**
   * Dispatches a trigger to create an investigation.
   * Returns the dispatch result with investigation ID.
   */
  dispatch(trigger: Trigger): Promise<TriggerDispatchResult>;
}

/**
 * Interface for the TriggerRegistry.
 * Manages registration and lookup of trigger adapters.
 */
export interface ITriggerRegistry {
  /**
   * Registers a trigger adapter for a specific source and type.
   */
  register(adapter: ITriggerAdapter): void;

  /**
   * Finds an adapter that can handle the given source and type.
   */
  findAdapter(source: string, type: string): ITriggerAdapter | undefined;

  /**
   * Returns all registered adapters.
   */
  getAdapters(): ITriggerAdapter[];
}
