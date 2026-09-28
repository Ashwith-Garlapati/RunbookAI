/**
 * Infrastructure - generic in-process event bus.
 *
 * Single pub/sub implementation shared by the investigation and incident
 * domains. Typed handlers, `*` wildcard support, per-handler isolation via
 * allSettled. No persistence, no broker — swap the repository/bus wiring in
 * index.ts when out-of-process delivery is needed.
 */

export interface BusEvent {
  readonly eventType: string;
}

export interface BusHandler<TEvent extends BusEvent> {
  handle(event: TEvent): Promise<void>;
}

export class EventBus<TEvent extends BusEvent> {
  private readonly _handlers: Map<string, Array<BusHandler<TEvent>>> = new Map();

  constructor(private readonly _onError?: (event: TEvent, reason: unknown) => void) {}

  subscribe(eventType: string, handler: BusHandler<TEvent>): void {
    const existing = this._handlers.get(eventType) ?? [];
    existing.push(handler);
    this._handlers.set(eventType, existing);
  }

  unsubscribe(eventType: string, handler: BusHandler<TEvent>): void {
    const existing = this._handlers.get(eventType);
    if (existing) {
      const index = existing.indexOf(handler);
      if (index !== -1) existing.splice(index, 1);
    }
  }

  async publish(event: TEvent): Promise<void> {
    const typed = this._handlers.get(event.eventType) ?? [];
    const wildcard = this._handlers.get("*") ?? [];
    const results = await Promise.allSettled([...typed, ...wildcard].map((h) => h.handle(event)));
    for (const result of results) {
      if (result.status === "rejected") {
        if (this._onError) this._onError(event, result.reason);
        else console.error("[EventBus] Handler error:", result.reason);
      }
    }
  }
}
