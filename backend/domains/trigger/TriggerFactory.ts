/**
 * Trigger Domain - Trigger Factory
 *
 * Creates Trigger objects from raw external event data.
 * Uses adapters to convert raw events and validates the result.
 *
 * The factory ensures that only valid Triggers are created.
 * It does NOT contain business logic - it only converts and validates.
 */

import type { Trigger } from "../investigation/Trigger.js";
import type { ITriggerAdapter, ITriggerFactory } from "./interfaces.js";
import { TriggerValidator } from "./TriggerValidator.js";
import { TriggerValidationError } from "./types.js";

export class TriggerFactory implements ITriggerFactory {
  private readonly _validator: TriggerValidator;

  constructor(validator?: TriggerValidator) {
    this._validator = validator ?? new TriggerValidator();
  }

  /**
   * Creates a Trigger from raw external event data using the provided adapter.
   *
   * @param adapter - The adapter to convert raw event to Trigger
   * @param rawEvent - The raw event data from the external system
   * @returns A validated Trigger object
   * @throws TriggerValidationError if the adapter returns null or validation fails
   */
  create(adapter: ITriggerAdapter, rawEvent: unknown): Trigger {
    const trigger = adapter.adapt(rawEvent);

    if (trigger === null) {
      throw new TriggerValidationError(
        `Adapter ${adapter.source}/${adapter.type} could not convert the raw event to a Trigger`,
      );
    }

    this._validator.validate(trigger);

    return trigger;
  }
}
