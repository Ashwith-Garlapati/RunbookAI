import { describe, it, expect, beforeEach, vi } from "vitest";
import { SlackSlashCommandAdapter } from "../domains/trigger/adapters/SlackSlashCommandAdapter.js";
import { SlackShortcutAdapter } from "../domains/trigger/adapters/SlackShortcutAdapter.js";
import { SlackMentionAdapter } from "../domains/trigger/adapters/SlackMentionAdapter.js";
import { TriggerFactory } from "../domains/trigger/TriggerFactory.js";
import { TriggerValidator } from "../domains/trigger/TriggerValidator.js";
import { TriggerDispatcher } from "../domains/trigger/TriggerDispatcher.js";
import { TriggerRegistry } from "../domains/trigger/TriggerRegistry.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import type { InvestigationService } from "../domains/investigation/InvestigationService.js";

function createMockInvestigationService(): InvestigationService {
  return {
    createInvestigation: vi.fn(async (params) => ({
      id: `inv-${Date.now()}`,
      title: params.title,
      description: params.description,
      severity: params.severity,
      status: "Draft",
      trigger: params.trigger,
      createdBy: params.createdBy,
    })),
  } as unknown as InvestigationService;
}

describe("Slack Slash Command Trigger Integration", () => {
  let registry: TriggerRegistry;
  let factory: TriggerFactory;
  let dispatcher: TriggerDispatcher;
  let service: InvestigationService;

  beforeEach(() => {
    registry = new TriggerRegistry();
    factory = new TriggerFactory();
    service = createMockInvestigationService();
    dispatcher = new TriggerDispatcher(service);

    registry.register(new SlackSlashCommandAdapter());
    registry.register(new SlackShortcutAdapter());
    registry.register(new SlackMentionAdapter());
  });

  it("processes /investigate command successfully", async () => {
    const rawEvent = {
      command: "/investigate",
      text: "checkout API failures",
      user_id: "U12345",
      user_name: "john.doe",
      channel_id: "C12345",
      channel_name: "incidents",
      team_id: "T12345",
      trigger_id: "1234567890.123456",
      api_app_id: "A12345",
      token: "verification_token",
      response_url: "https://hooks.slack.com/actions/123",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    expect(adapter).toBeDefined();

    const trigger = factory.create(adapter!, rawEvent);
    expect(trigger.source).toBe(TriggerSource.Slack);
    expect(trigger.type).toBe(TriggerType.SlashCommand);
    expect(trigger.actor).toBe("U12345");
    expect(trigger.payload.text).toBe("checkout API failures");

    const result = await dispatcher.dispatch(trigger);

    expect(result.success).toBe(true);
    expect(result.investigationId).toBeTruthy();
    expect(service.createInvestigation).toHaveBeenCalled();
  });

  it("processes /runbook start command successfully", async () => {
    const rawEvent = {
      command: "/runbook",
      text: "start database connection issues",
      user_id: "U12345",
      user_name: "john.doe",
      channel_id: "C12345",
      channel_name: "incidents",
      team_id: "T12345",
      trigger_id: "1234567890.123456",
      api_app_id: "A12345",
      token: "verification_token",
      response_url: "https://hooks.slack.com/actions/123",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    const trigger = factory.create(adapter!, rawEvent);

    expect(trigger.type).toBe(TriggerType.SlashCommand);
    expect(trigger.payload.text).toBe("start database connection issues");

    const result = await dispatcher.dispatch(trigger);
    expect(result.success).toBe(true);
  });

  it("rejects /runbook command without 'start'", async () => {
    const rawEvent = {
      command: "/runbook",
      text: "help me",
      user_id: "U12345",
      channel_id: "C12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });

  it("rejects command without user_id", async () => {
    const rawEvent = {
      command: "/investigate",
      text: "test",
      channel_id: "C12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });

  it("rejects unknown command", async () => {
    const rawEvent = {
      command: "/unknown",
      text: "test",
      user_id: "U12345",
      channel_id: "C12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });
});

describe("Slack Message Shortcut Trigger Integration", () => {
  let registry: TriggerRegistry;
  let factory: TriggerFactory;
  let dispatcher: TriggerDispatcher;
  let service: InvestigationService;

  beforeEach(() => {
    registry = new TriggerRegistry();
    factory = new TriggerFactory();
    service = createMockInvestigationService();
    dispatcher = new TriggerDispatcher(service);

    registry.register(new SlackSlashCommandAdapter());
    registry.register(new SlackShortcutAdapter());
    registry.register(new SlackMentionAdapter());
  });

  it("processes investigate_with_runbookai shortcut successfully", async () => {
    const rawEvent = {
      type: "message_action",
      callback_id: "investigate_with_runbookai",
      user: {
        id: "U12345",
        username: "john.doe",
        name: "John Doe",
      },
      channel: {
        id: "C12345",
        name: "incidents",
      },
      message: {
        text: "We're seeing 500 errors on the checkout API",
        ts: "1234567890.123456",
        thread_ts: "1234567890.123450",
      },
      team_id: "T12345",
      trigger_id: "1234567890.123456",
      api_app_id: "A12345",
      token: "verification_token",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.MessageShortcut);
    expect(adapter).toBeDefined();

    const trigger = factory.create(adapter!, rawEvent);
    expect(trigger.source).toBe(TriggerSource.Slack);
    expect(trigger.type).toBe(TriggerType.MessageShortcut);
    expect(trigger.actor).toBe("U12345");
    expect(trigger.payload.messageText).toBe("We're seeing 500 errors on the checkout API");
    expect(trigger.payload.threadTs).toBe("1234567890.123450");

    const result = await dispatcher.dispatch(trigger);

    expect(result.success).toBe(true);
    expect(result.investigationId).toBeTruthy();
    expect(service.createInvestigation).toHaveBeenCalled();
  });

  it("rejects shortcut with wrong callback_id", async () => {
    const rawEvent = {
      type: "message_action",
      callback_id: "wrong_callback",
      user: { id: "U12345" },
      channel: { id: "C12345" },
      message: { text: "test" },
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.MessageShortcut);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });

  it("rejects shortcut without user", async () => {
    const rawEvent = {
      type: "message_action",
      callback_id: "investigate_with_runbookai",
      channel: { id: "C12345" },
      message: { text: "test" },
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.MessageShortcut);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });

  it("rejects shortcut without channel", async () => {
    const rawEvent = {
      type: "message_action",
      callback_id: "investigate_with_runbookai",
      user: { id: "U12345" },
      message: { text: "test" },
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.MessageShortcut);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });
});

describe("Slack @RunbookAI Mention Trigger Integration", () => {
  let registry: TriggerRegistry;
  let factory: TriggerFactory;
  let dispatcher: TriggerDispatcher;
  let service: InvestigationService;

  beforeEach(() => {
    registry = new TriggerRegistry();
    factory = new TriggerFactory();
    service = createMockInvestigationService();
    dispatcher = new TriggerDispatcher(service);

    registry.register(new SlackSlashCommandAdapter());
    registry.register(new SlackShortcutAdapter());
    registry.register(new SlackMentionAdapter());
  });

  it("processes @RunbookAI mention successfully", async () => {
    const rawEvent = {
      type: "app_mention",
      user: "U12345",
      text: "<@U_BOT_ID> investigate checkout API failures",
      ts: "1234567890.123456",
      channel: "C12345",
      team: "T12345",
      api_app_id: "A12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
    expect(adapter).toBeDefined();

    const trigger = factory.create(adapter!, rawEvent);
    expect(trigger.source).toBe(TriggerSource.Slack);
    expect(trigger.type).toBe(TriggerType.Mention);
    expect(trigger.actor).toBe("U12345");
    expect(trigger.payload.messageText).toBe("investigate checkout API failures");

    const result = await dispatcher.dispatch(trigger);

    expect(result.success).toBe(true);
    expect(result.investigationId).toBeTruthy();
    expect(service.createInvestigation).toHaveBeenCalled();
  });

  it("processes @RunbookAI mention in a thread", async () => {
    const rawEvent = {
      type: "app_mention",
      user: "U12345",
      text: "<@U_BOT_ID> investigate this issue",
      ts: "1234567890.123456",
      channel: "C12345",
      thread_ts: "1234567890.123450",
      team: "T12345",
      api_app_id: "A12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
    const trigger = factory.create(adapter!, rawEvent);

    expect(trigger.payload.threadTs).toBe("1234567890.123450");
    expect(trigger.metadata.isThread).toBe(true);

    const result = await dispatcher.dispatch(trigger);
    expect(result.success).toBe(true);
  });

  it("rejects mention without user", async () => {
    const rawEvent = {
      type: "app_mention",
      text: "<@U_BOT_ID> investigate",
      channel: "C12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });

  it("rejects mention without text", async () => {
    const rawEvent = {
      type: "app_mention",
      user: "U12345",
      channel: "C12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });

  it("rejects bot messages to prevent loops", async () => {
    const rawEvent = {
      type: "app_mention",
      user: "U12345",
      text: "<@U_BOT_ID> investigate",
      channel: "C12345",
      bot_id: "B12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });

  it("rejects mention with only @mention text", async () => {
    const rawEvent = {
      type: "app_mention",
      user: "U12345",
      text: "<@U_BOT_ID>",
      channel: "C12345",
    };

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
    const trigger = adapter?.adapt(rawEvent);

    expect(trigger).toBeNull();
  });
});

describe("Full Trigger Pipeline Integration", () => {
  it("runs complete pipeline from raw event to investigation creation", async () => {
    const registry = new TriggerRegistry();
    const factory = new TriggerFactory();
    const service = createMockInvestigationService();
    const dispatcher = new TriggerDispatcher(service);

    registry.register(new SlackSlashCommandAdapter());
    registry.register(new SlackShortcutAdapter());
    registry.register(new SlackMentionAdapter());

    const rawEvent = {
      command: "/investigate",
      text: "production database is down",
      user_id: "U12345",
      user_name: "john.doe",
      channel_id: "C12345",
      channel_name: "incidents",
      team_id: "T12345",
      trigger_id: "1234567890.123456",
      api_app_id: "A12345",
      token: "verification_token",
      response_url: "https://hooks.slack.com/actions/123",
    };

    // Step 1: Find adapter
    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    expect(adapter).toBeDefined();

    // Step 2: Create trigger
    const trigger = factory.create(adapter!, rawEvent);
    expect(trigger).toBeDefined();
    expect(trigger.source).toBe(TriggerSource.Slack);
    expect(trigger.type).toBe(TriggerType.SlashCommand);

    // Step 3: Validate trigger
    const validator = new TriggerValidator();
    expect(validator.validate(trigger)).toBe(true);

    // Step 4: Dispatch
    const result = await dispatcher.dispatch(trigger);
    expect(result.success).toBe(true);
    expect(result.investigationId).toBeTruthy();

    // Verify InvestigationService was called correctly
    expect(service.createInvestigation).toHaveBeenCalledTimes(1);
    const callArgs = (service.createInvestigation as any).mock.calls[0][0];
    expect(callArgs.title).toBe("production database is down");
    expect(callArgs.severity).toBe("medium");
    expect(callArgs.createdBy).toBe("U12345");
    expect(callArgs.metadata.triggerSource).toBe("slack");
    expect(callArgs.metadata.triggerType).toBe("slash_command");
  });
});
