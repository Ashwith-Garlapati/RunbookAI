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
import { MentionIntentDetector } from "../services/MentionIntentDetector.js";
import type { QuestionAnsweringService } from "../services/QuestionAnsweringService.js";

function createMockInvestigationService(): InvestigationService {
  const service = {
    createInvestigation: vi.fn(async (params) => ({
      id: `inv-${Date.now()}`,
      title: params.title,
      description: params.description,
      severity: params.severity,
      status: "Draft",
      trigger: params.trigger,
      createdBy: params.createdBy,
    })),
    createOrAssociateInvestigation: vi.fn(async (params) => {
      const investigation = await service.createInvestigation(params);
      return { kind: "created", investigation };
    }),
    findBySlackContext: vi.fn(async () => undefined),
    resolveInvestigation: vi.fn(async () => ({})),
    updateInvestigationMetadata: vi.fn(async () => ({})),
    getInvestigation: vi.fn(async () => null),
    getTimeline: vi.fn(async () => []),
  } as unknown as InvestigationService;
  return service;
}

function createMockQuestionService(): QuestionAnsweringService {
  return {
    answer: vi.fn(async () => ({ answer: "mock answer", contextFound: true })),
  } as unknown as QuestionAnsweringService;
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
    conversations: {
      history: vi.fn(async () => ({ messages: [] })),
      create: vi.fn(async () => ({ channel: { id: "CNEW" } })),
    },
    pins: {
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    },
  };
}

describe("Slack Handlers - Trigger Layer Integration", () => {
  let registry: TriggerRegistry;
  let factory: TriggerFactory;
  let dispatcher: TriggerDispatcher;
  let service: InvestigationService;
  let client: ReturnType<typeof createMockSlackClient>;
  let intentDetector: MentionIntentDetector;

  function makeDeps() {
    return {
      registry,
      factory,
      dispatcher,
      investigationService: service,
      intentDetector,
      questionService: createMockQuestionService(),
    };
  }

  beforeEach(() => {
    registry = new TriggerRegistry();
    registry.register(new SlackSlashCommandAdapter());
    registry.register(new SlackShortcutAdapter());
    registry.register(new SlackMentionAdapter());

    const validator = new TriggerValidator();
    factory = new TriggerFactory(validator);
    service = createMockInvestigationService();
    dispatcher = new TriggerDispatcher(service);
    client = createMockSlackClient();
    intentDetector = new MentionIntentDetector();
  });

  const basicCommand = {
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

  describe("/investigate slash command", () => {
    it("creates investigation and responds with ID", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

      const handler = bolt.handlers["command:/investigate"];
      expect(handler).toBeDefined();

      await handler({ command: basicCommand, ack: vi.fn(), client });

      expect(service.createInvestigation).toHaveBeenCalled();
      expect(client.chat.postEphemeral).toHaveBeenCalled();
      const callArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
      expect(callArgs.text).toContain("Investigation Created");
    });

    it("handles empty text", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

      const handler = bolt.handlers["command:/investigate"];

      await handler({ command: { ...basicCommand, text: "" }, ack: vi.fn(), client });

      expect(service.createInvestigation).toHaveBeenCalled();
    });

    it("does NOT read Slack channel history", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

      const handler = bolt.handlers["command:/investigate"];

      await handler({ command: basicCommand, ack: vi.fn(), client });

      expect(client.conversations.history).not.toHaveBeenCalled();
    });

    it("never goes through the association flow (always clean creation)", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

      const dispatchSpy = vi.spyOn(dispatcher, "dispatch");
      const handler = bolt.handlers["command:/investigate"];

      await handler({ command: basicCommand, ack: vi.fn(), client });

      expect(dispatchSpy).toHaveBeenCalled();
      const [, options] = dispatchSpy.mock.calls[0];
      expect(options).toBeUndefined();
      expect(service.createOrAssociateInvestigation).not.toHaveBeenCalled();
      expect(service.createInvestigation).toHaveBeenCalled();
      dispatchSpy.mockRestore();
    });

    it("does NOT create an incident channel", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

      const handler = bolt.handlers["command:/investigate"];

      await handler({ command: basicCommand, ack: vi.fn(), client });

      expect(client.conversations.create).not.toHaveBeenCalled();
    });

    it("does NOT post or pin an investigation card", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

      const handler = bolt.handlers["command:/investigate"];

      await handler({ command: basicCommand, ack: vi.fn(), client });

      expect(client.pins.add).not.toHaveBeenCalled();
      const ephemeral = (client.chat.postEphemeral as any).mock.calls[0][0];
      expect(ephemeral.blocks).toBeDefined();
      // The confirmation only mentions Evidence: 0 collected - no card was pinned.
      expect(JSON.stringify(ephemeral.blocks)).toContain("Evidence:");
    });

    it("returns error when dispatch fails", async () => {
      const bolt = createMockBolt();
      (service.createInvestigation as any).mockRejectedValue(new Error("Database error"));

      registerSlackHandlers(bolt as any, makeDeps());

      const handler = bolt.handlers["command:/investigate"];

      await handler({ command: { ...basicCommand, text: "test issue" }, ack: vi.fn(), client });

      expect(client.chat.postEphemeral).toHaveBeenCalled();
      const callArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
      expect(callArgs.text).toContain("Something went wrong");
    });
  });

  describe("/runbook slash command (removed)", () => {
    it("registers no /runbook handler", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

      expect(bolt.handlers["command:/runbook"]).toBeUndefined();
      expect(bolt.handlers["command:/investigate"]).toBeDefined();
    });
  });

  describe("@RunbookAI mention", () => {
    it("creates investigation from mention", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

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
      registerSlackHandlers(bolt as any, makeDeps());

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
      registerSlackHandlers(bolt as any, makeDeps());

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
      registerSlackHandlers(bolt as any, makeDeps());

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

      const ephemeralCalls = (client.chat.postEphemeral as any).mock.calls;
      const confirmation = ephemeralCalls.find(
        (call: any) =>
          JSON.stringify(call[0].blocks ?? []).includes("Investigation Created"),
      );
      expect(confirmation).toBeDefined();
      const blockText = JSON.stringify(confirmation[0].blocks);
      expect(blockText).toContain("Investigation Created");
      expect(blockText).toContain("Draft");
      expect(blockText).toContain("Evidence:");
      expect(blockText).toContain("Next steps:");
    });

    it("supports thread replies", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

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
      registerSlackHandlers(bolt as any, makeDeps());

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
      expect(client.pins.add).not.toHaveBeenCalled();
    });

    it("uses the same association logic as mentions (associate dispatch)", async () => {
      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());

      const dispatchSpy = vi.spyOn(dispatcher, "dispatch");

      const shortcut = {
        type: "message_action",
        callback_id: "investigate_with_runbookai",
        user: { id: "U12345", username: "john.doe", name: "John Doe" },
        channel: { id: "C12345", name: "incidents" },
        message: { text: "checkout API 500s", ts: "1234567890.123456" },
        team: { id: "T12345" },
        trigger_id: "1234567890.123456",
        api_app_id: "A12345",
        token: "verification_token",
      };

      await (bolt.handlers["shortcut:investigate_with_runbookai"] as any)({
        shortcut,
        ack: vi.fn(),
        client,
      });

      expect(dispatchSpy).toHaveBeenCalled();
      const [triggerArg, options] = dispatchSpy.mock.calls[0];
      expect(options).toEqual({ associate: true });
      expect(triggerArg.type).toBe(TriggerType.MessageShortcut);
      expect(service.createOrAssociateInvestigation).toHaveBeenCalled();
      dispatchSpy.mockRestore();
    });

    it("reuses an existing investigation through the shortcut (same ID)", async () => {
      (service.createOrAssociateInvestigation as any).mockResolvedValue({
        kind: "reused",
        association: "channel",
        investigation: {
          id: "INV-001",
          title: "Checkout API failures",
          status: "collecting_evidence",
          createdAt: new Date(),
          metadata: {},
        },
      });

      const bolt = createMockBolt();
      registerSlackHandlers(bolt as any, makeDeps());
      const handler = bolt.handlers["shortcut:investigate_with_runbookai"];
      const shortcut = {
        type: "message.shortcut",
        callback_id: "investigate_with_runbookai",
        user: { id: "U12345", username: "john.doe" },
        channel: { id: "C12345", name: "incidents" },
        message: { text: "checkout API 500s", ts: "1234567890.123456" },
        team: { id: "T12345" },
        trigger_id: "1234567890.123456",
        api_app_id: "A12345",
        token: "verification_token",
      };

      await handler({ shortcut, ack: vi.fn(), client });

      const ephemeral = (client.chat.postEphemeral as any).mock.calls[0][0];
      expect(ephemeral.text).toContain("Investigation Reused");
      expect(JSON.stringify(ephemeral.blocks)).toContain("INV-001");
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
      registerSlackHandlers(bolt as any, makeDeps());

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
