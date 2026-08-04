import { describe, it, expect, vi } from "vitest";
import { TriggerValidator } from "../domains/trigger/TriggerValidator.js";
import { TriggerFactory } from "../domains/trigger/TriggerFactory.js";
import { TriggerDispatcher } from "../domains/trigger/TriggerDispatcher.js";
import { TriggerRegistry } from "../domains/trigger/TriggerRegistry.js";
import { TriggerValidationError } from "../domains/trigger/types.js";
import { Trigger } from "../domains/investigation/Trigger.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import type { ITriggerAdapter } from "../domains/trigger/interfaces.js";
import type { InvestigationService } from "../domains/investigation/InvestigationService.js";

function createValidTrigger(): Trigger {
  return Trigger.create({
    source: TriggerSource.Slack,
    type: TriggerType.SlashCommand,
    actor: "U12345",
    payload: { command: "/investigate", text: "test issue" },
    metadata: { slackChannelId: "C12345" },
  });
}

function createMockAdapter(
  source: string = TriggerSource.Slack,
  type: string = TriggerType.SlashCommand,
): ITriggerAdapter {
  return {
    source,
    type,
    adapt: vi.fn(() => createValidTrigger()),
  };
}

function createMockInvestigationService(): InvestigationService {
  return {
    createInvestigation: vi.fn(async () => ({
      id: "inv-123",
      title: "Test Investigation",
      status: "Draft",
    })),
  } as unknown as InvestigationService;
}

describe("TriggerValidator", () => {
  const validator = new TriggerValidator();

  it("validates a valid trigger", () => {
    const trigger = createValidTrigger();
    expect(validator.validate(trigger)).toBe(true);
  });

  it("rejects null input", () => {
    expect(() => validator.validate(null)).toThrow(TriggerValidationError);
  });

  it("rejects non-object input", () => {
    expect(() => validator.validate("string")).toThrow(TriggerValidationError);
  });

  it("rejects trigger with empty id", () => {
    const trigger = createValidTrigger();
    (trigger as any).id = "";
    expect(() => validator.validate(trigger)).toThrow("Trigger id must be a non-empty string");
  });

  it("rejects trigger with unsupported source", () => {
    const trigger = createValidTrigger();
    (trigger as any).source = "unsupported";
    expect(() => validator.validate(trigger)).toThrow("Unsupported trigger source");
  });

  it("rejects trigger with unsupported type", () => {
    const trigger = createValidTrigger();
    (trigger as any).type = "unsupported_type";
    expect(() => validator.validate(trigger)).toThrow("Unsupported trigger type");
  });

  it("rejects trigger with empty actor", () => {
    const trigger = createValidTrigger();
    (trigger as any).actor = "";
    expect(() => validator.validate(trigger)).toThrow("Trigger actor must be a non-empty string");
  });

  it("rejects trigger with null payload", () => {
    const trigger = createValidTrigger();
    (trigger as any).payload = null;
    expect(() => validator.validate(trigger)).toThrow("Trigger payload must be a non-null object");
  });

  it("rejects trigger with array payload", () => {
    const trigger = createValidTrigger();
    (trigger as any).payload = [];
    expect(() => validator.validate(trigger)).toThrow("Trigger payload must be a non-null object");
  });

  it("rejects trigger with invalid timestamp", () => {
    const trigger = createValidTrigger();
    (trigger as any).timestamp = "not a date";
    expect(() => validator.validate(trigger)).toThrow("Trigger timestamp must be a valid Date");
  });

  it("rejects trigger with null metadata", () => {
    const trigger = createValidTrigger();
    (trigger as any).metadata = null;
    expect(() => validator.validate(trigger)).toThrow("Trigger metadata must be a non-null object");
  });

  it("allows empty payload and metadata", () => {
    const trigger = Trigger.create({
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      actor: "U12345",
    });
    expect(validator.validate(trigger)).toBe(true);
  });
});

describe("TriggerFactory", () => {
  it("creates a trigger from adapter output", () => {
    const factory = new TriggerFactory();
    const adapter = createMockAdapter();
    const rawEvent = { command: "/investigate", text: "test" };

    const trigger = factory.create(adapter, rawEvent);

    expect(adapter.adapt).toHaveBeenCalledWith(rawEvent);
    expect(trigger.source).toBe(TriggerSource.Slack);
    expect(trigger.type).toBe(TriggerType.SlashCommand);
    expect(trigger.actor).toBe("U12345");
  });

  it("throws when adapter returns null", () => {
    const factory = new TriggerFactory();
    const adapter: ITriggerAdapter = {
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      adapt: vi.fn(() => null),
    };

    expect(() => factory.create(adapter, {})).toThrow(TriggerValidationError);
  });

  it("throws when validation fails", () => {
    const factory = new TriggerFactory();
    const adapter: ITriggerAdapter = {
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      adapt: vi.fn(() => {
        const trigger = createValidTrigger();
        (trigger as any).actor = "";
        return trigger;
      }),
    };

    expect(() => factory.create(adapter, {})).toThrow(TriggerValidationError);
  });
});

describe("TriggerDispatcher", () => {
  it("dispatches a trigger and returns success", async () => {
    const service = createMockInvestigationService();
    const dispatcher = new TriggerDispatcher(service);
    const trigger = createValidTrigger();

    const result = await dispatcher.dispatch(trigger);

    expect(result.success).toBe(true);
    expect(result.investigationId).toBe("inv-123");
    expect(result.triggerId).toBe(trigger.id);
    expect(service.createInvestigation).toHaveBeenCalled();
  });

  it("extracts title from trigger text", async () => {
    const service = createMockInvestigationService();
    const dispatcher = new TriggerDispatcher(service);
    const trigger = Trigger.create({
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      actor: "U12345",
      payload: { text: "checkout API failures" },
    });

    await dispatcher.dispatch(trigger);

    const callArgs = (service.createInvestigation as any).mock.calls[0][0];
    expect(callArgs.title).toBe("checkout API failures");
  });

  it("uses default title when no text", async () => {
    const service = createMockInvestigationService();
    const dispatcher = new TriggerDispatcher(service);
    const trigger = Trigger.create({
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      actor: "U12345",
    });

    await dispatcher.dispatch(trigger);

    const callArgs = (service.createInvestigation as any).mock.calls[0][0];
    expect(callArgs.title).toBe("Investigation from slack slash_command");
  });

  it("extracts severity from trigger payload", async () => {
    const service = createMockInvestigationService();
    const dispatcher = new TriggerDispatcher(service);
    const trigger = Trigger.create({
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      actor: "U12345",
      payload: { severity: "high" },
    });

    await dispatcher.dispatch(trigger);

    const callArgs = (service.createInvestigation as any).mock.calls[0][0];
    expect(callArgs.severity).toBe("high");
  });

  it("defaults severity to medium", async () => {
    const service = createMockInvestigationService();
    const dispatcher = new TriggerDispatcher(service);
    const trigger = createValidTrigger();

    await dispatcher.dispatch(trigger);

    const callArgs = (service.createInvestigation as any).mock.calls[0][0];
    expect(callArgs.severity).toBe("medium");
  });

  it("returns error result when service throws", async () => {
    const service = createMockInvestigationService();
    (service.createInvestigation as any).mockRejectedValue(new Error("Database error"));
    const dispatcher = new TriggerDispatcher(service);
    const trigger = createValidTrigger();

    const result = await dispatcher.dispatch(trigger);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Database error");
  });

  it("preserves trigger metadata in investigation", async () => {
    const service = createMockInvestigationService();
    const dispatcher = new TriggerDispatcher(service);
    const trigger = Trigger.create({
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      actor: "U12345",
      payload: { channel: "C12345" },
      metadata: { customField: "customValue" },
    });

    await dispatcher.dispatch(trigger);

    const callArgs = (service.createInvestigation as any).mock.calls[0][0];
    expect(callArgs.metadata.triggerSource).toBe("slack");
    expect(callArgs.metadata.triggerType).toBe("slash_command");
    expect(callArgs.metadata.customField).toBe("customValue");
  });
});

describe("TriggerRegistry", () => {
  it("registers and finds an adapter", () => {
    const registry = new TriggerRegistry();
    const adapter = createMockAdapter();

    registry.register(adapter);

    const found = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    expect(found).toBe(adapter);
  });

  it("returns undefined for unregistered adapter", () => {
    const registry = new TriggerRegistry();

    const found = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    expect(found).toBeUndefined();
  });

  it("replaces adapter with same source/type", () => {
    const registry = new TriggerRegistry();
    const adapter1 = createMockAdapter();
    const adapter2 = createMockAdapter();

    registry.register(adapter1);
    registry.register(adapter2);

    const found = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    expect(found).toBe(adapter2);
  });

  it("returns all registered adapters", () => {
    const registry = new TriggerRegistry();
    const adapter1 = createMockAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    const adapter2 = createMockAdapter(TriggerSource.Slack, TriggerType.MessageShortcut);

    registry.register(adapter1);
    registry.register(adapter2);

    const adapters = registry.getAdapters();
    expect(adapters).toHaveLength(2);
    expect(adapters).toContain(adapter1);
    expect(adapters).toContain(adapter2);
  });
});
