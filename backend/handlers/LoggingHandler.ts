/**
 * Investigation Domain - Logging Handler
 *
 * Logs all domain events to console for debugging and monitoring.
 * This handler provides visibility into domain event flow without
 * coupling to any specific logging infrastructure.
 *
 * In production, this could be replaced with a handler that sends
 * events to a logging service (e.g., Datadog, CloudWatch, ELK).
 */

import type { IDomainEvent, IEventHandler } from "../domains/investigation/interfaces.js";

export class LoggingHandler implements IEventHandler {
  async handle(event: IDomainEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown> | undefined;
    const payloadStr = payload ? ` | payload=${JSON.stringify(payload)}` : "";
    console.log(
      `[DomainEvent] ${event.eventType} | investigation=${event.investigationId} | at=${event.occurredAt.toISOString()}${payloadStr}`,
    );
  }
}
