import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerSlackHandlers } from "../handlers/SlackHandlers.js";
import { TriggerRegistry } from "../domains/trigger/TriggerRegistry.js";
import { TriggerFactory } from "../domains/trigger/TriggerFactory.js";
import { TriggerDispatcher } from "../domains/trigger/TriggerDispatcher.js";
import { TriggerValidator } from "../domains/trigger/TriggerValidator.js";
import { SlackSlashCommandAdapter } from "../domains/trigger/adapters/SlackSlashCommandAdapter.js";
import { SlackShortcutAdapter } from "../domains/trigger/adapters/SlackShortcutAdapter.js";
import { SlackMentionAdapter } from "../domains/trigger/adapters/SlackMentionAdapter.js";
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

function createMockBolt() {
  const handlers: Record<string, Function> = {};
  return {
    command: vi.fn((cmd: string, handler: Function) => {
      handlers[`command:${cmd}`] = handler;
    }),
    event: vi.fn((event: string, handler: Function) => {
      handlers[`event:${event}`] = handler;
    }),
    shortcut: vi.fn((shortcut: string, handler: Function) => {
      handlers[`shortcut:${shortcut}`] = handler;
    }),
    action: vi.fn((action: string, handler: Function) => {
      handlers[`action:${action}`] = handler;
    }),
    handlers,
  };
}

function createMockSlackClient() {
  return {
    chat: {
      postEphemeral: vi.fn(async () => ({})),
      postMessage: vi.fn(async () => ({})),
    },
    views: {
      open: vi.fn(async () => ({})),
    },
  };
}

describe("Slack Handlers - Trigger Layer Integration", () => {
  let registry: TriggerRegistry;
  let factory: TriggerFactory;
  let dispatcher: TriggerDispatcher;
  let service: InvestigationService;

  beforeEach(() => {
    registry = new TriggerRegistry();
    registry.register(new SlackSlashCommandAdapter());
    registry.register(new SlackShortcutAdapter());
    registry.register(new SlackMentionAdapter());

    const validator = new TriggerValidator();
    factory = new TriggerFactory(validator);
    service = createMockInvestigationService();
    dispatcher = new TriggerDispatcher(service);
  });

  describe("/investigate slash command", () => {
    it("creates investigation and responds with ID", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["command:/investigate"];
      expect(handler).toBeDefined();

      const command = {
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

      await handler({ command, ack: vi.fn(), client });

      expect(service.createInvestigation).toHaveBeenCalled();
      expect(client.chat.postEphemeral).toHaveBeenCalled();
      const callArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
      expect(callArgs.text).toContain("Investigation Created");
    });

    it("handles empty text", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["command:/investigate"];

      const command = {
        command: "/investigate",
        text: "",
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

      await handler({ command, ack: vi.fn(), client });

      expect(service.createInvestigation).toHaveBeenCalled();
    });

    it("returns error when dispatch fails", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      (service.createInvestigation as any).mockRejectedValue(new Error("Database error"));

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["command:/investigate"];

      const command = {
        command: "/investigate",
        text: "test issue",
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

      await handler({ command, ack: vi.fn(), client });

      expect(client.chat.postEphemeral).toHaveBeenCalled();
      const callArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
      expect(callArgs.text).toContain("Failed");
    });
  });

  describe("/runbook start slash command", () => {
    it("creates investigation via Trigger Layer", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["command:/runbook"];
      expect(handler).toBeDefined();

      const command = {
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

      await handler({ command, ack: vi.fn(), client });

      expect(service.createInvestigation).toHaveBeenCalled();
      expect(client.chat.postEphemeral).toHaveBeenCalled();
    });

    it("does not create investigation for non-start subcommands", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["command:/runbook"];

      const command = {
        command: "/runbook",
        text: "search database",
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

      await handler({ command, ack: vi.fn(), client });

      expect(service.createInvestigation).not.toHaveBeenCalled();
    });
  });

  describe("@RunbookAI mention", () => {
    it("creates investigation from mention", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["event:app_mention"];
      expect(handler).toBeDefined();

      const event = {
        type: "app_mention",
        user: "U12345",
        text: "<@U_BOT_ID> investigate checkout API failures",
        ts: "1234567890.123456",
        channel: "C12345",
        team: "T12345",
        api_app_id: "A12345",
      };

      await handler({ event, client });

      expect(service.createInvestigation).toHaveBeenCalled();
      expect(client.chat.postMessage).toHaveBeenCalled();
    });

    it("ignores bot messages", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["event:app_mention"];

      const event = {
        type: "app_mention",
        user: "U12345",
        text: "<@U_BOT_ID> investigate",
        ts: "1234567890.123456",
        channel: "C12345",
        team: "T12345",
        bot_id: "B12345",
      };

      await handler({ event, client });

      expect(service.createInvestigation).not.toHaveBeenCalled();
    });

    it("ignores mentions containing only the bot mention", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["event:app_mention"];

      const event = {
        type: "app_mention",
        user: "U12345",
        text: "<@U_BOT_ID>",
        ts: "1234567890.123456",
        channel: "C12345",
        team: "T12345",
      };

      await handler({ event, client });

      expect(service.createInvestigation).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it("responds with investigation ID, status and trigger", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["event:app_mention"];

      const event = {
        type: "app_mention",
        user: "U12345",
        text: "<@U_BOT_ID> investigate checkout API failures",
        ts: "1234567890.123456",
        channel: "C12345",
        team: "T12345",
        api_app_id: "A12345",
      };

      await handler({ event, client });

      const postMessageArgs = (client.chat.postMessage as any).mock.calls[0][0];
      const blockText = JSON.stringify(postMessageArgs.blocks);
      expect(blockText).toContain("Investigation Created");
      expect(blockText).toContain("Draft");
      expect(blockText).toContain("Mention");
    });

    it("supports thread replies", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["event:app_mention"];

      const event = {
        type: "app_mention",
        user: "U12345",
        text: "<@U_BOT_ID> investigate this issue",
        ts: "1234567890.123456",
        channel: "C12345",
        thread_ts: "1234567890.123450",
        team: "T12345",
        api_app_id: "A12345",
      };

      await handler({ event, client });

      expect(service.createInvestigation).toHaveBeenCalled();
      const postMessageArgs = (client.chat.postMessage as any).mock.calls[0][0];
      expect(postMessageArgs.thread_ts).toBe("1234567890.123450");
    });
  });

  describe("Message shortcut", () => {
    it("creates investigation from shortcut", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["shortcut:investigate_with_runbookai"];
      expect(handler).toBeDefined();

      const shortcut = {
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
        },
        team: { id: "T12345" },
        trigger_id: "1234567890.123456",
        api_app_id: "A12345",
        token: "verification_token",
      };

      await handler({ shortcut, ack: vi.fn(), client });

      expect(service.createInvestigation).toHaveBeenCalled();
      expect(client.chat.postEphemeral).toHaveBeenCalled();
    });
  });

  describe("Registry lookup", () => {
    it("finds correct adapter for slash command", () => {
      const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
      expect(adapter).toBeDefined();
      expect(adapter?.source).toBe(TriggerSource.Slack);
      expect(adapter?.type).toBe(TriggerType.SlashCommand);
    });

    it("finds correct adapter for mention", () => {
      const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
      expect(adapter).toBeDefined();
      expect(adapter?.source).toBe(TriggerSource.Slack);
      expect(adapter?.type).toBe(TriggerType.Mention);
    });

    it("finds correct adapter for shortcut", () => {
      const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.MessageShortcut);
      expect(adapter).toBeDefined();
      expect(adapter?.source).toBe(TriggerSource.Slack);
      expect(adapter?.type).toBe(TriggerType.MessageShortcut);
    });

    it("returns undefined for unknown trigger type", () => {
      const adapter = registry.findAdapter(TriggerSource.Slack, "unknown_type");
      expect(adapter).toBeUndefined();
    });
  });

  describe("Validation failures", () => {
    it("returns error for invalid slash command payload", async () => {
      const bolt = createMockBolt();
      const client = createMockSlackClient();

      registerSlackHandlers(bolt as any, { registry, factory, dispatcher });

      const handler = bolt.handlers["command:/investigate"];

      const command = {
        command: "/investigate",
        text: "test",
        channel_id: "C12345",
        team_id: "T12345",
      };

      await handler({ command, ack: vi.fn(), client });

      expect(service.createInvestigation).not.toHaveBeenCalled();
    });
  });
});
