/**
 * Trigger Domain - Trigger Validator
 *
 * Validates that a Trigger object has all required fields and valid values.
 * Rejects malformed triggers before they reach the dispatcher.
 *
 * Validation rules:
 * - id must be a non-empty string
 * - source must be a supported trigger source
 * - type must be a supported trigger type
 * - actor must be a non-empty string
 * - payload must be an object (can be empty)
 * - timestamp must be a valid Date
 * - metadata must be an object (can be empty)
 */

import type { Trigger } from "../investigation/Trigger.js";
import { TriggerSource } from "../investigation/TriggerSource.js";
import { TriggerType } from "../investigation/TriggerType.js";
import { TriggerValidationError } from "./types.js";

const SUPPORTED_SOURCES: Set<string> = new Set(Object.values(TriggerSource));
const SUPPORTED_TYPES: Set<string> = new Set(Object.values(TriggerType));

export class TriggerValidator {
  /**
   * Validates a trigger object. Returns true if valid, throws TriggerValidationError if invalid.
   */
  validate(trigger: unknown): trigger is Trigger {
    if (typeof trigger !== "object" || trigger === null) {
      throw new TriggerValidationError("Trigger must be a non-null object");
    }

    const t = trigger as Record<string, unknown>;

    // Validate id
    if (typeof t.id !== "string" || t.id.trim().length === 0) {
      throw new TriggerValidationError("Trigger id must be a non-empty string");
    }

    // Validate source
    if (typeof t.source !== "string" || !SUPPORTED_SOURCES.has(t.source)) {
      throw new TriggerValidationError(
        `Unsupported trigger source: ${String(t.source)}. Supported sources: ${[...SUPPORTED_SOURCES].join(", ")}`,
      );
    }

    // Validate type
    if (typeof t.type !== "string" || !SUPPORTED_TYPES.has(t.type)) {
      throw new TriggerValidationError(
        `Unsupported trigger type: ${String(t.type)}. Supported types: ${[...SUPPORTED_TYPES].join(", ")}`,
      );
    }

    // Validate actor
    if (typeof t.actor !== "string" || t.actor.trim().length === 0) {
      throw new TriggerValidationError("Trigger actor must be a non-empty string");
    }

    // Validate payload (must be an object, can be empty)
    if (typeof t.payload !== "object" || t.payload === null || Array.isArray(t.payload)) {
      throw new TriggerValidationError("Trigger payload must be a non-null object");
    }

    // Validate timestamp
    if (!(t.timestamp instanceof Date) || isNaN(t.timestamp.getTime())) {
      throw new TriggerValidationError("Trigger timestamp must be a valid Date");
    }

    // Validate metadata (must be an object, can be empty)
    if (typeof t.metadata !== "object" || t.metadata === null || Array.isArray(t.metadata)) {
      throw new TriggerValidationError("Trigger metadata must be a non-null object");
    }

    return true;
  }
}
