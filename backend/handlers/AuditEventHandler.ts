import type { IDomainEvent, IEventHandler } from "../domains/investigation/interfaces.js";

export class AuditEventHandler implements IEventHandler {
  async handle(event: IDomainEvent): Promise<void> {
    console.log(
      `[Audit] ${event.eventType} | investigation=${event.investigationId} | at=${event.occurredAt.toISOString()}`,
    );
  }
}
