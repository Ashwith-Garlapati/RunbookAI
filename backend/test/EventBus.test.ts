import { describe, it, expect, vi, beforeEach } from "vitest";
import { InProcessEventBus } from "../infrastructure/InProcessEventBus.js";
import type { IDomainEvent, IEventHandler } from "../domains/investigation/interfaces.js";

function createTestEvent(
  eventType: string = "TestEvent",
  investigationId: string = "inv-1",
): IDomainEvent {
  return {
    eventId: "evt-1",
    eventType,
    occurredAt: new Date(),
    investigationId: investigationId as any,
  };
}

describe("InProcessEventBus", () => {
  let bus: InProcessEventBus;

  beforeEach(() => {
    bus = new InProcessEventBus();
  });

  describe("subscribe and publish", () => {
    it("delivers events to subscribed handlers", async () => {
      const handler: IEventHandler = {
        handle: vi.fn(async () => {}),
      };

      bus.subscribe("TestEvent", handler);
      await bus.publish(createTestEvent("TestEvent"));

      expect(handler.handle).toHaveBeenCalledOnce();
      expect(handler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "TestEvent" }),
      );
    });

    it("delivers to multiple handlers for same event type", async () => {
      const handler1: IEventHandler = {
        handle: vi.fn(async () => {}),
      };
      const handler2: IEventHandler = {
        handle: vi.fn(async () => {}),
      };

      bus.subscribe("TestEvent", handler1);
      bus.subscribe("TestEvent", handler2);
      await bus.publish(createTestEvent("TestEvent"));

      expect(handler1.handle).toHaveBeenCalledOnce();
      expect(handler2.handle).toHaveBeenCalledOnce();
    });

    it("does not deliver to handlers subscribed to different event types", async () => {
      const handler: IEventHandler = {
        handle: vi.fn(async () => {}),
      };

      bus.subscribe("OtherEvent", handler);
      await bus.publish(createTestEvent("TestEvent"));

      expect(handler.handle).not.toHaveBeenCalled();
    });

    it("supports wildcard subscriptions", async () => {
      const handler: IEventHandler = {
        handle: vi.fn(async () => {}),
      };

      bus.subscribe("*", handler);
      await bus.publish(createTestEvent("TestEvent"));
      await bus.publish(createTestEvent("OtherEvent"));

      expect(handler.handle).toHaveBeenCalledTimes(2);
    });

    it("delivers to both typed and wildcard handlers", async () => {
      const typedHandler: IEventHandler = {
        handle: vi.fn(async () => {}),
      };
      const wildcardHandler: IEventHandler = {
        handle: vi.fn(async () => {}),
      };

      bus.subscribe("TestEvent", typedHandler);
      bus.subscribe("*", wildcardHandler);
      await bus.publish(createTestEvent("TestEvent"));

      expect(typedHandler.handle).toHaveBeenCalledOnce();
      expect(wildcardHandler.handle).toHaveBeenCalledOnce();
    });
  });

  describe("unsubscribe", () => {
    it("removes a specific handler", async () => {
      const handler: IEventHandler = {
        handle: vi.fn(async () => {}),
      };

      bus.subscribe("TestEvent", handler);
      bus.unsubscribe("TestEvent", handler);
      await bus.publish(createTestEvent("TestEvent"));

      expect(handler.handle).not.toHaveBeenCalled();
    });

    it("does not affect other handlers when unsubscribing", async () => {
      const handler1: IEventHandler = {
        handle: vi.fn(async () => {}),
      };
      const handler2: IEventHandler = {
        handle: vi.fn(async () => {}),
      };

      bus.subscribe("TestEvent", handler1);
      bus.subscribe("TestEvent", handler2);
      bus.unsubscribe("TestEvent", handler1);
      await bus.publish(createTestEvent("TestEvent"));

      expect(handler1.handle).not.toHaveBeenCalled();
      expect(handler2.handle).toHaveBeenCalledOnce();
    });
  });

  describe("error handling", () => {
    it("isolates handler errors from other handlers", async () => {
      const failingHandler: IEventHandler = {
        handle: vi.fn(async () => {
          throw new Error("Handler failed");
        }),
      };
      const successHandler: IEventHandler = {
        handle: vi.fn(async () => {}),
      };

      bus.subscribe("TestEvent", failingHandler);
      bus.subscribe("TestEvent", successHandler);

      // Should not throw
      await bus.publish(createTestEvent("TestEvent"));

      expect(successHandler.handle).toHaveBeenCalledOnce();
    });
  });
});
