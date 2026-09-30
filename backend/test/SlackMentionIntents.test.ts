import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerSlackHandlers } from "../handlers/SlackHandlers.js";
import { TriggerRegistry } from "../domains/trigger/TriggerRegistry.js";
import { TriggerFactory } from "../domains/trigger/TriggerFactory.js";
import { TriggerDispatcher } from "../domains/trigger/TriggerDispatcher.js";
import { TriggerValidator } from "../domains/trigger/TriggerValidator.js";
import { SlackSlashCommandAdapter } from "../domains/trigger/adapters/SlackSlashCommandAdapter.js";
import { SlackShortcutAdapter } from "../domains/trigger/adapters/SlackShortcutAdapter.js";
import { SlackMentionAdapter } from "../domains/trigger/adapters/SlackMentionAdapter.js";
import type { InvestigationService } from "../domains/investigation/InvestigationService.js";
import { MentionIntentDetector } from "../services/MentionIntentDetector.js";
import type { QuestionAnsweringService } from "../services/QuestionAnsweringService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";

function createMockInvestigationService(): InvestigationService {
  const createdBase = {
    id: "inv-mention-1",
    status: InvestigationStatus.Draft,
    createdAt: new Date(),
    metadata: {},
  };
  const service = {
    createInvestigation: vi.fn(async (params) => ({
      ...createdBase,
      title: params.title,
      description: params.description,
      severity: params.severity,
      trigger: params.trigger,
      createdBy: params.createdBy,
    })),
    createOrAssociateInvestigation: vi.fn(async (params) => {
      const investigation = await service.createInvestigation(params);
      return { kind: "created", investigation };
    }),
    findBySlackContext: vi.fn(async () => undefined),
    resolveInvestigation: vi.fn(async (id, resolvedBy) => ({
      id,
      title: "Checkout API failures",
      status: InvestigationStatus.Resolved,
      resolvedBy,
      resolvedAt: new Date("2026-08-07T10:00:00Z"),
      metadata: {},
    })),
    updateInvestigationMetadata: vi.fn(async () => ({})),
    getInvestigation: vi.fn(async () => null),
    getTimeline: vi.fn(async () => []),
  };
  return service as unknown as InvestigationService;
}

function createMockQuestionService(answer = "Here is a context-based answer."): QuestionAnsweringService {
  return {
    answer: vi.fn(async () => ({ answer, contextFound: true })),
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
    handlers,
  };
}

function createMockSlackClient(postMessageResult: { ts?: string } = {}) {
  return {
    chat: {
      postEphemeral: vi.fn(async () => ({})),
      postMessage: vi.fn(async () => postMessageResult),
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

function baseMention(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "app_mention",
    user: "U12345",
    text: "<@U_BOT_ID> investigate this",
    ts: "1234567890.123456",
    channel: "C12345",
    team: "T12345",
    api_app_id: "A12345",
    ...overrides,
  };
}

describe("@RunbookAI Mention Intents", () => {
  let registry: TriggerRegistry;
  let factory: TriggerFactory;
  let dispatcher: TriggerDispatcher;
  let service: InvestigationService;
  let client: ReturnType<typeof createMockSlackClient>;

  function makeDeps(questionService?: QuestionAnsweringService) {
    return {
      registry,
      factory,
      dispatcher,
      investigationService: service,
      intentDetector: new MentionIntentDetector(),
      questionService: questionService ?? createMockQuestionService(),
    };
  }

  beforeEach(() => {
    registry = new TriggerRegistry();
    registry.register(new SlackSlashCommandAdapter());
    registry.register(new SlackShortcutAdapter());
    registry.register(new SlackMentionAdapter());

    factory = new TriggerFactory(new TriggerValidator());
    service = createMockInvestigationService();
    dispatcher = new TriggerDispatcher(service);
    client = createMockSlackClient({ ts: "1234567890.123999" });
  });

  async function invokeMention(event: Record<string, unknown>) {
    const bolt = createMockBolt();
    registerSlackHandlers(bolt as any, makeDeps());
    const handler = bolt.handlers["event:app_mention"];
    await handler({ event, client });
  }

  it("investigates: '@RunbookAI investigate this' creates an investigation", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

    expect(service.createInvestigation).toHaveBeenCalledTimes(1);
  });

  it("investigates: '@RunbookAI investigate checkout API failures' creates an investigation", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate checkout API failures" }));

    expect(service.createInvestigation).toHaveBeenCalledTimes(1);
  });

  it("investigates: '@RunbookAI start investigation' creates an investigation", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> start investigation" }));

    expect(service.createInvestigation).toHaveBeenCalledTimes(1);
  });

  it("questions: 'summarize this thread' answers WITHOUT creating an investigation", async () => {
    const questionService = createMockQuestionService("Summary of the thread...");
    const bolt = createMockBolt();
    registerSlackHandlers(bolt as any, makeDeps(questionService));
    const handler = bolt.handlers["event:app_mention"];

    await handler({
      event: baseMention({ text: "<@U_BOT_ID> summarize this thread" }),
      client,
    });

    expect(service.createInvestigation).not.toHaveBeenCalled();
    expect(questionService.answer).toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalled();
    const postArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
    expect(postArgs.text).toContain("Summary of the thread...");
  });

  it("questions: 'what caused this?' answers WITHOUT creating an investigation", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> what caused this?" }));

    expect(service.createInvestigation).not.toHaveBeenCalled();
  });

  it("questions: 'what changed today?' answers WITHOUT creating an investigation", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> what changed today?" }));

    expect(service.createInvestigation).not.toHaveBeenCalled();
  });

  it("resolves: '@RunbookAI resolve this investigation' resolves the linked investigation", async () => {
    (service.findBySlackContext as any).mockResolvedValue({
      id: "inv-123",
      title: "Checkout API failures",
      status: InvestigationStatus.CollectingEvidence,
      metadata: {},
    });

    await invokeMention(baseMention({ text: "<@U_BOT_ID> resolve this investigation" }));

    expect(service.createInvestigation).not.toHaveBeenCalled();
    expect(service.resolveInvestigation).toHaveBeenCalledWith("inv-123", "U12345");
    expect(client.chat.postEphemeral).toHaveBeenCalled();

    const blocks = JSON.stringify((client.chat.postEphemeral as any).mock.calls[0][0].blocks);
    expect(blocks).toContain("Investigation Resolved");
    expect(blocks).toContain("Resolved");
    expect(blocks).toContain("U12345");
  });

  it("resolves: '@RunbookAI close this incident' resolves the linked investigation", async () => {
    (service.findBySlackContext as any).mockResolvedValue({
      id: "inv-123",
      title: "Checkout API failures",
      status: InvestigationStatus.Draft,
      metadata: {},
    });

    await invokeMention(baseMention({ text: "<@U_BOT_ID> close this incident" }));

    expect(service.resolveInvestigation).toHaveBeenCalledWith("inv-123", "U12345");
  });

  it("resolves: asks for an investigation when nothing is linked", async () => {
    (service.findBySlackContext as any).mockResolvedValue(undefined);

    await invokeMention(baseMention({ text: "<@U_BOT_ID> resolve this investigation" }));

    expect(service.resolveInvestigation).not.toHaveBeenCalled();
    const postArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
    expect(postArgs.text).toContain("couldn't find a linked investigation");
  });

  it("resolves: does not double-resolve an already resolved investigation", async () => {
    (service.findBySlackContext as any).mockResolvedValue({
      id: "inv-123",
      title: "Checkout API failures",
      status: InvestigationStatus.Resolved,
      resolvedBy: "U99999",
      metadata: {},
    });

    await invokeMention(baseMention({ text: "<@U_BOT_ID> resolve this investigation" }));

    expect(service.resolveInvestigation).not.toHaveBeenCalled();
    const postArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
    expect(postArgs.text).toContain("already resolved");
  });

  it("help: '@RunbookAI help' returns help text without side effects", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> help" }));

    expect(service.createInvestigation).not.toHaveBeenCalled();
    expect(service.resolveInvestigation).not.toHaveBeenCalled();
    const postArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
    expect(JSON.stringify(postArgs.blocks)).toContain("Investigate");
    expect(JSON.stringify(postArgs.blocks)).toContain("Resolve");
  });

  it("help: '@RunbookAI what can you do?' returns help text", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> what can you do?" }));

    expect(service.createInvestigation).not.toHaveBeenCalled();
  });

  it("unknown: ambiguous mentions get a clarification instead of a wrong investigation", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> !!?" }));

    expect(service.createInvestigation).not.toHaveBeenCalled();
    const postArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
    expect(postArgs.text).toContain("not sure what you'd like me to do");
  });

  it("ignores empty mentions (only the bot mention)", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID>" }));

    expect(service.createInvestigation).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("ignores bot messages", async () => {
    await invokeMention(baseMention({ bot_id: "B12345", text: "<@U_BOT_ID> investigate this" }));

    expect(service.createInvestigation).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("thread mention preserves thread metadata for the Evidence Layer", async () => {
    await invokeMention(
      baseMention({
        text: "<@U_BOT_ID> investigate this issue",
        ts: "1111111111.111111",
        thread_ts: "2222222222.222222",
      }),
    );

    expect(service.createInvestigation).toHaveBeenCalledTimes(1);
    const callArgs = (service.createInvestigation as any).mock.calls[0][0];
    expect(callArgs.metadata.slackChannelId).toBe("C12345");
    expect(callArgs.metadata.threadTs).toBe("2222222222.222222");
    expect(callArgs.metadata.messageTs).toBe("1111111111.111111");
    expect(callArgs.metadata.isThread).toBe(true);
  });

  it("does not create a Slack incident channel for mentions", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

    expect(client.conversations.create).not.toHaveBeenCalled();
  });

  it("does not read Slack history for mentions", async () => {
    await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  describe("investigation association", () => {
    function mockReusedInv(investigationId: string, association = "thread") {
      (service.createOrAssociateInvestigation as any).mockResolvedValue({
        kind: "reused",
        association,
        investigation: {
          id: investigationId,
          title: "Checkout API failures",
          status: InvestigationStatus.CollectingEvidence,
          createdAt: new Date(),
          metadata: {},
        },
      });
    }

    it("mention creates an investigation when none exists", async () => {
      await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

      expect(service.createOrAssociateInvestigation).toHaveBeenCalledTimes(1);
      expect(service.createInvestigation).toHaveBeenCalledTimes(1);
      const confirmation = (client.chat.postEphemeral as any).mock.calls.find((call: any) =>
        JSON.stringify(call[0].blocks ?? []).includes("Investigation Created"),
      );
      expect(confirmation).toBeDefined();
      expect(JSON.stringify(confirmation[0].blocks)).toContain("Investigation Created");
    });

    it("mention reuses a /investigate-created investigation", async () => {
      mockReusedInv("INV-001", "channel");

      await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

      const postArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
      expect(postArgs.text).toContain("Investigation Reused");
      const blocks = JSON.stringify(postArgs.blocks);
      expect(blocks).toContain("INV-001");
      expect(blocks).toContain("already active in this channel");
      // A reused investigation must NOT get a duplicate incident card.
      const cardCalls = (client.chat.postMessage as any).mock.calls.filter(
        (call: any) => JSON.stringify(call[0].blocks ?? []).includes("Investigation Card"),
      );
      expect(cardCalls).toHaveLength(0);
      expect(service.updateInvestigationMetadata).not.toHaveBeenCalled();
    });

    it("repeated mention is idempotent and returns the same investigation", async () => {
      mockReusedInv("INV-1", "thread");

      await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));
      await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

      expect(service.createOrAssociateInvestigation).toHaveBeenCalledTimes(2);
      const ids = (client.chat.postEphemeral as any).mock.calls.map((call: any) =>
        JSON.stringify(call[0].blocks ?? []) === "[]" ? call[0].text : call[0].blocks[1].fields[0].text,
      );
      expect(ids).toContain("*ID:*\nINV-1");
      expect(client.chat.postEphemeral).toHaveBeenCalledTimes(2);
    });

    it("asks the user to choose when multiple investigations match", async () => {
      (service.createOrAssociateInvestigation as any).mockResolvedValue({
        kind: "needs_choice",
        candidates: [
          {
            id: "INV-1",
            title: "Checkout API failures",
            status: InvestigationStatus.CollectingEvidence,
          },
          {
            id: "INV-2",
            title: "Payment service degraded",
            status: InvestigationStatus.Draft,
          },
        ],
      });

      await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

      const postArgs = (client.chat.postEphemeral as any).mock.calls[0][0];
      expect(postArgs.text).toContain("I found *2 active investigations*");
      expect(postArgs.text).toContain("INV-1");
      expect(postArgs.text).toContain("INV-2");
      expect(postArgs.text).toContain("@RunbookAI use INV-1");
      // No investigation may be created when the user must choose.
      expect(service.createInvestigation).not.toHaveBeenCalled();
    });

    it("question mention does not create an investigation", async () => {
      await invokeMention(baseMention({ text: "<@U_BOT_ID> summarize what happened" }));

      expect(service.createOrAssociateInvestigation).not.toHaveBeenCalled();
      expect(service.createInvestigation).not.toHaveBeenCalled();
      expect(client.chat.postEphemeral).toHaveBeenCalled();
    });
  });

  describe("investigation card pin behavior", () => {
    it("posts a card and pins it when the mention is inside an incident thread", async () => {
      await invokeMention(
        baseMention({
          text: "<@U_BOT_ID> investigate this issue",
          thread_ts: "2222222222.222222",
        }),
      );

      // Card posted in the thread
      const cardCalls = (client.chat.postMessage as any).mock.calls;
      const cardCall = cardCalls.find(
        (call: any) => JSON.stringify(call[0].blocks ?? []).includes("Investigation Card"),
      );
      expect(cardCall).toBeDefined();
      expect(cardCall[0].thread_ts).toBe("2222222222.222222");

      // Pinned because the conversation is the incident thread
      expect(client.pins.add).toHaveBeenCalledWith({
        channel: "C12345",
        timestamp: "1234567890.123999",
      });

      // Card ts persisted for later updates/unpins
      expect(service.updateInvestigationMetadata).toHaveBeenCalledWith(
        "inv-mention-1",
        "slackCardTs",
        "1234567890.123999",
      );
    });

    it("posts a card WITHOUT pinning when the mention is not in a thread", async () => {
      await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

      expect(client.pins.add).not.toHaveBeenCalled();
      const cardCalls = (client.chat.postMessage as any).mock.calls;
      const cardCall = cardCalls.find(
        (call: any) => JSON.stringify(call[0].blocks ?? []).includes("Investigation Card"),
      );
      expect(cardCall).toBeDefined();
    });

    it("posts no card when the card service fails", async () => {
      client.chat.postMessage.mockResolvedValue({});
      await invokeMention(baseMention({ text: "<@U_BOT_ID> investigate this" }));

      expect(client.pins.add).not.toHaveBeenCalled();
      expect(service.updateInvestigationMetadata).not.toHaveBeenCalled();
      // The investigation is still created and the confirmation is still sent.
      expect(service.createInvestigation).toHaveBeenCalledTimes(1);
    });
  });
});
