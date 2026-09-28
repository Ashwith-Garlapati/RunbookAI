/**
 * Incident Domain - incident event bus (in-process).
 */

import type { IncidentDomainEvent, IncidentEventType } from "./IncidentEvents.js";
import { EventBus } from "../../infrastructure/EventBus.js";
import { logger } from "../../observability/logger.js";

export interface IIncidentEventHandler {
  handle(event: IncidentDomainEvent): Promise<void>;
}

export class IncidentBus extends EventBus<IncidentDomainEvent> {
  constructor() {
    super((event, reason) =>
      logger.error("IncidentBus", "HandlerFailed", {
        correlationId: event.eventId,
        incidentId: event.incidentId,
        eventType: event.eventType,
        reason: String(reason),
      }),
    );
  }

  subscribe(eventType: IncidentEventType | "*", handler: IIncidentEventHandler): void {
    super.subscribe(eventType, handler);
  }

  async publishAll(events: IncidentDomainEvent[]): Promise<void> {
    for (const event of events) await this.publish(event);
  }
}
