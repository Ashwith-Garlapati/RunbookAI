import type { IDomainEvent, IEventBus, IEventHandler } from "../domains/investigation/interfaces.js";

export class InProcessEventBus implements IEventBus {
  private handlers: Map<string, IEventHandler[]> = new Map();

  subscribe(eventType: string, handler: IEventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  unsubscribe(eventType: string, handler: IEventHandler): void {
    const existing = this.handlers.get(eventType);
    if (existing) {
      const index = existing.indexOf(handler);
      if (index !== -1) {
        existing.splice(index, 1);
      }
    }
  }

  async publish(event: IDomainEvent): Promise<void> {
    const typedHandlers = this.handlers.get(event.eventType) ?? [];
    const wildcardHandlers = this.handlers.get("*") ?? [];
    const allHandlers = [...typedHandlers, ...wildcardHandlers];

    const results = await Promise.allSettled(
      allHandlers.map(async (handler) => {
        await handler.handle(event);
      })
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[EventBus] Handler error:", result.reason);
      }
    }
  }
}
