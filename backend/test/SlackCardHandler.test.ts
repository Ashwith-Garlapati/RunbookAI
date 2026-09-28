import { describe, it, expect, beforeEach, vi } from "vitest";
import { SlackCardHandler } from "../handlers/SlackCardHandler.js";
import { SlackIncidentCardService } from "../services/SlackIncidentCardService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import type { IDomainEvent } from "../domains/investigation/interfaces.js";
import type { Investigation } from "../domains/investigation/Investigation.js";

function createMockInvestigation(metadata: Record<string, unknown> = {}): Investigation {
  return {
    id: "inv-1",
    title: "Checkout API failures",
    metadata,
  } as unknown as Investigation;
}

function createMockInvestigationService(investigation: Investigation) {
  return {
    getInvestigation: vi.fn(async () => investigation),
  };
}

function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ts: "123.456" })),
      update: vi.fn(async () => ({})),
    },
    pins: {
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    },
  };
}

function createResolvedEvent(investigationId = "inv-1"): IDomainEvent {
  return {
    eventId: "event-1",
    eventType: "InvestigationResolved",
    occurredAt: new Date(),
    investigationId,
    payload: { resolvedBy: "U12345" },
  };
}

function createRunbookAttachedEvent(investigationId = "inv-1"): IDomainEvent {
  return {
    eventId: "event-2",
    eventType: "RunbookAttached",
    occurredAt: new Date(),
    investigationId,
    payload: { runbookId: "rb-1" },
  };
}

describe("SlackCardHandler - incident card lifecycle", () => {
  let client: ReturnType<typeof createMockClient>;
  let cardService: SlackIncidentCardService;

  beforeEach(() => {
    client = createMockClient();
    cardService = new SlackIncidentCardService(client);
  });

  it("updates the card to Resolved when the investigation is resolved", async () => {
    const investigation = createMockInvestigation({
      slackChannelId: "C12345",
      slackCardTs: "123.456",
    });
    const handler = new SlackCardHandler(
      cardService,
      createMockInvestigationService(investigation) as any,
    );

    await handler.handle(createResolvedEvent());

    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const args = (client.chat.update as any).mock.calls[0][0];
    expect(args.channel).toBe("C12345");
    expect(args.ts).toBe("123.456");
    expect(JSON.stringify(args.blocks)).toContain("Resolved");
  });

  it("unpins the card only after the runbook is attached (post-resolution)", async () => {
    const investigation = createMockInvestigation({
      slackChannelId: "C12345",
      slackCardTs: "123.456",
    });
    const handler = new SlackCardHandler(
      cardService,
      createMockInvestigationService(investigation) as any,
    );

    await handler.handle(createRunbookAttachedEvent());

    expect(client.pins.remove).toHaveBeenCalledWith({
      channel: "C12345",
      timestamp: "123.456",
    });
  });

  it("does NOT unpin on resolution - only after the runbook is published", async () => {
    const investigation = createMockInvestigation({
      slackChannelId: "C12345",
      slackCardTs: "123.456",
    });
    const handler = new SlackCardHandler(
      cardService,
      createMockInvestigationService(investigation) as any,
    );

    await handler.handle(createResolvedEvent());

    expect(client.pins.remove).not.toHaveBeenCalled();
  });

  it("does nothing for investigations without a card (slash-command created)", async () => {
    const investigation = createMockInvestigation({});
    const handler = new SlackCardHandler(
      cardService,
      createMockInvestigationService(investigation) as any,
    );

    await handler.handle(createResolvedEvent());
    await handler.handle(createRunbookAttachedEvent());

    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.pins.remove).not.toHaveBeenCalled();
  });

  it("ignores unrelated domain events", async () => {
    const investigation = createMockInvestigation({
      slackChannelId: "C12345",
      slackCardTs: "123.456",
    });
    const handler = new SlackCardHandler(
      cardService,
      createMockInvestigationService(investigation) as any,
    );

    await handler.handle({
      eventId: "event-3",
      eventType: "InvestigationCreated",
      occurredAt: new Date(),
      investigationId: "inv-1",
      payload: {},
    });

    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.pins.remove).not.toHaveBeenCalled();
  });
});

describe("SlackIncidentCardService", () => {
  let client: ReturnType<typeof createMockClient>;
  let cardService: SlackIncidentCardService;

  beforeEach(() => {
    client = createMockClient();
    cardService = new SlackIncidentCardService(client);
  });

  it("posts a card with thread context and pins it when requested", async () => {
    const ts = await cardService.postInvestigationCard({
      channelId: "C12345",
      threadTs: "222.222",
      title: "Checkout API failures",
      investigationId: "inv-1",
      status: InvestigationStatus.Draft,
      pin: true,
    });

    expect(ts).toBe("123.456");
    const postArgs = (client.chat.postMessage as any).mock.calls[0][0];
    expect(postArgs.thread_ts).toBe("222.222");
    expect(JSON.stringify(postArgs.blocks)).toContain("Investigation Card");
    expect(client.pins.add).toHaveBeenCalledWith({
      channel: "C12345",
      timestamp: "123.456",
    });
  });

  it("does not pin when pin is not requested", async () => {
    await cardService.postInvestigationCard({
      channelId: "C12345",
      title: "Checkout API failures",
      investigationId: "inv-1",
      status: InvestigationStatus.Draft,
      pin: false,
    });

    expect(client.pins.add).not.toHaveBeenCalled();
  });

  it("unpins the card by channel and timestamp", async () => {
    await cardService.unpinInvestigationCard("C12345", "123.456");

    expect(client.pins.remove).toHaveBeenCalledWith({
      channel: "C12345",
      timestamp: "123.456",
    });
  });
});
