/**
 * Investigation Domain - Core Interfaces
 *
 * Defines the foundational contracts for domain events and event handling.
 * All domain events must implement IDomainEvent.
 * The IEventBus provides decoupled communication between domain components.
 */

import type { InvestigationId } from "./types.js";

/**
 * Represents an immutable domain event that occurred within an Investigation.
 * Events are the primary mechanism for communicating state changes.
 *
 * The base interface defines common fields. Each specific event type
 * extends this with a typed payload, maintaining structural compatibility
 * while preserving type safety for consumers.
 */
export interface IDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly investigationId: InvestigationId;
  readonly payload?: unknown;
}

/**
 * Contract for publishing domain events.
 * Implementations handle delivery (in-process, message broker, etc.)
 */
export interface IEventBus {
  publish(event: IDomainEvent): Promise<void>;
  subscribe(eventType: string, handler: IEventHandler): void;
  unsubscribe(eventType: string, handler: IEventHandler): void;
}

/**
 * Contract for consuming domain events.
 * Implementations react to specific event types.
 */
export interface IEventHandler {
  handle(event: IDomainEvent): Promise<void>;
}
