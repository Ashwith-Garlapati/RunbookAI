import { describe, it, expect, beforeEach } from "vitest";
import { InvestigationService } from "../domains/investigation/InvestigationService.js";
import type { ConversationContext } from "../domains/investigation/InvestigationService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import { Trigger } from "../domains/investigation/Trigger.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import { TimelineService } from "../domains/investigation/TimelineService.js";
import { TimelineEventType } from "../domains/investigation/TimelineEventType.js";
import { InProcessEventBus } from "../infrastructure/InProcessEventBus.js";
import { TriggerRegistry } from "../domains/trigger/TriggerRegistry.js";
import { TriggerFactory } from "../domains/trigger/TriggerFactory.js";
import { TriggerDispatcher } from "../domains/trigger/TriggerDispatcher.js";
import { SlackSlashCommandAdapter } from "../domains/trigger/adapters/SlackSlashCommandAdapter.js";
import { SlackMentionAdapter } from "../domains/trigger/adapters/SlackMentionAdapter.js";
import type { Investigation } from "../domains/investigation/Investigation.js";
import type { IInvestigationRepository } from "../domains/investigation/InvestigationRepository.js";
import type { IDomainEvent, IEventHandler } from "../domains/investigation/interfaces.js";

const NON_REUSABLE_STATUSES = new Set([
  InvestigationStatus.Resolved,
  InvestigationStatus.Completed,
  InvestigationStatus.Archived,
]);

class MemoryRepository implements IInvestigationRepository {
  private readonly items = new Map<string, Investigation>();

  private readonly all = (): Investigation[] => [...this.items.values()];

  private readonly reusable = (): Investigation[] =>
    this.all().filter((inv) => !NON_REUSABLE_STATUSES.has(inv.status));

  private readonly sorted = (items: Investigation[]): Investigation[] =>
    [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  async create(investigation: Investigation): Promise<Investigation> {
    this.items.set(investigation.id, investigation);
    return investigation;
  }

  async update(investigation: Investigation): Promise<Investigation> {
    this.items.set(investigation.id, investigation);
    return investigation;
  }

  async findById(id: string): Promise<Investigation | null> {
    return this.items.get(id) ?? null;
  }

  async findByStatus(status: InvestigationStatus): Promise<Investigation[]> {
    return this.all().filter((inv) => inv.status === status);
  }

  async findActive(): Promise<Investigation[]> {
    return this.reusable();
  }

  async findCompleted(): Promise<Investigation[]> {
    return this.all().filter((inv) => inv.status === InvestigationStatus.Completed);
  }

  async findBySlackChannel(channelId: string): Promise<Investigation[]> {
    return this.sorted(this.all().filter((inv) => inv.metadata.slackChannelId === channelId));
  }

  async findReusableBySlackThread(
    teamId: string,
    channelId: string,
    threadTs: string,
  ): Promise<Investigation[]> {
    return this.sorted(
      this.reusable().filter(
        (inv) =>
          inv.metadata.teamId === teamId &&
          inv.metadata.channelId === channelId &&
          inv.metadata.threadTs === threadTs,
      ),
    );
  }

  async findReusableBySlackChannel(teamId: string, channelId: string): Promise<Investigation[]> {
    return this.sorted(
      this.reusable().filter(
        (inv) => inv.metadata.teamId === teamId && inv.metadata.channelId === channelId,
      ),
    );
  }

  async findByReusableSlackUser(params: {
    teamId: string;
    createdBy: string;
    createdAfter: Date;
  }): Promise<Investigation[]> {
    return this.sorted(
      this.reusable().filter(
        (inv) =>
          inv.metadata.teamId === params.teamId &&
          inv.createdBy === params.createdBy &&
          inv.createdAt.getTime() >= params.createdAfter.getTime(),
      ),
    );
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

interface ConversationSeed {
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs?: string;
  readonly rootMessageTs?: string;
}

function createTrigger(actor: string, conversation: ConversationSeed): Trigger {
  const threadTs = conversation.threadTs ?? "";
  return Trigger.create({
    source: TriggerSource.Slack,
    type: TriggerType.Mention,
    actor,
    payload: { channel: conversation.channelId, teamId: conversation.teamId, threadTs },
    metadata: {
      slackUserId: actor,
      slackChannelId: conversation.channelId,
      slackTeamId: conversation.teamId,
      threadTs,
      messageTs: conversation.rootMessageTs ?? "1000000000.000000",
    },
  });
}

function contextMetadata(conversation: ConversationSeed): Record<string, unknown> {
  return {
    teamId: conversation.teamId,
    channelId: conversation.channelId,
    threadTs: conversation.threadTs ?? "",
    rootMessageTs: conversation.rootMessageTs ?? "",
  };
}

describe("Investigation Association", () => {
  let service: InvestigationService;
  let repository: IInvestigationRepository;
  let eventBus: InProcessEventBus;
  let timelineService: TimelineService;
  let publishedEvents: IDomainEvent[];

  beforeEach(() => {
    repository = new MemoryRepository();
    eventBus = new InProcessEventBus();
    timelineService = new TimelineService();
    publishedEvents = [];
    const collector: IEventHandler = {
      handle: async (event) => {
        publishedEvents.push(event);
      },
    };
    eventBus.subscribe("*", collector);
    service = new InvestigationService(repository, eventBus, timelineService);
  });

  async function seed(conversation: ConversationSeed, actor = "U12345"): Promise<Investigation> {
    return service.createInvestigation({
      title: "Seeded investigation",
      description: "seed",
      severity: "medium",
      trigger: createTrigger(actor, conversation),
      createdBy: actor,
      metadata: contextMetadata(conversation),
    });
  }

  async function acquire(conversation: ConversationContext, actor = "U12345") {
    const seedConv: ConversationSeed = {
      teamId: conversation.teamId ?? "",
      channelId: conversation.channelId ?? "",
      threadTs: conversation.threadTs ?? "",
      rootMessageTs: conversation.rootMessageTs ?? "",
    };
    return service.createOrAssociateInvestigation({
      title: "Investigate this incident",
      description: "Investigate this incident",
      severity: "medium",
      trigger: createTrigger(actor, seedConv),
      createdBy: actor,
      metadata: contextMetadata(seedConv),
      conversation,
    });
  }

  const C1: ConversationSeed = {
    teamId: "T1",
    channelId: "C1",
    rootMessageTs: "1111111111.111111",
  };
  const C2: ConversationSeed = {
    teamId: "T1",
    channelId: "C2",
    rootMessageTs: "2222222222.222222",
  };

  it("creates a new investigation when nothing matches", async () => {
    const result = await acquire(C1);

    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    const inv = result.investigation;
    expect(inv.metadata.channelId).toBe("C1");
    expect(inv.metadata.teamId).toBe("T1");
    expect(inv.metadata.threadTs).toBe("");
    expect(inv.metadata.rootMessageTs).toBe("1111111111.111111");
    expect(inv.createdBy).toBe("U12345");
  });

  it("reuses a /investigate-created investigation via channel match and stores context on the reuse", async () => {
    await seed(C1);

    const result = await acquire({ teamId: "T1", channelId: "C1", threadTs: "300.300" });

    expect(result.kind).toBe("reused");
    if (result.kind !== "reused") return;
    expect(result.association).toBe("channel");
    expect(result.investigation.title).toBe("Seeded investigation");

    // The conversation was newly linked to the reused investigation ->
    // exactly ONE ConversationAssociated event and ONE timeline entry.
    const associatedEvents = publishedEvents.filter((e) => e.eventType === "ConversationAssociated");
    expect(associatedEvents).toHaveLength(1);

    const timeline = await service.getTimeline(result.investigation.id);
    const associatedEntries = timeline.filter((entry) => entry.type === TimelineEventType.Associated);
    expect(associatedEntries).toHaveLength(1);

    // Context was stored on the reused investigation.
    expect(result.investigation.metadata.threadTs).toBe("300.300");
    expect(result.investigation.metadata.teamId).toBe("T1");
  });

  it("reuses an investigation via exact thread match without any new events", async () => {
    const seededInv = await seed({ ...C1, threadTs: "100.100" });

    const result = await acquire({ ...C1, threadTs: "100.100" });

    expect(result.kind).toBe("reused");
    if (result.kind !== "reused") return;
    expect(result.association).toBe("thread");
    expect(result.investigation.id).toBe(seededInv.id);

    const associatedEvents = publishedEvents.filter((e) => e.eventType === "ConversationAssociated");
    expect(associatedEvents).toHaveLength(0);

    const timeline = await service.getTimeline(seededInv.id);
    expect(timeline.filter((entry) => entry.type === TimelineEventType.Associated)).toHaveLength(0);
  });

  it("returns the same investigation on repeated mentions (idempotent)", async () => {
    await seed(C1);

    const first = await acquire(C1);
    const baselineEvents = publishedEvents.length;
    const second = await acquire(C1);

    expect(first.kind).toBe("reused");
    expect(second.kind).toBe("reused");
    if (first.kind !== "reused" || second.kind !== "reused") return;
    expect(first.investigation.id).toBe(second.investigation.id);

    // The repeated mention emitted no additional events or timeline entries.
    expect(publishedEvents.length).toBe(baselineEvents);
    const timeline = await service.getTimeline(first.investigation.id);
    expect(timeline.filter((entry) => entry.type === TimelineEventType.Associated)).toHaveLength(0);
  });

  it("reuses a same-user investigation created within the last 30 minutes", async () => {
    await seed(C2);

    const result = await acquire(C1);

    expect(result.kind).toBe("reused");
    if (result.kind !== "reused") return;
    expect(result.association).toBe("recent_user");
    expect(result.investigation.id).not.toBe(undefined);
    const timeline = await service.getTimeline(result.investigation.id);
    expect(timeline.filter((entry) => entry.type === TimelineEventType.Associated)).toHaveLength(1);
  });

  it("asks the user to choose when the channel matches multiple investigations", async () => {
    await seed({ ...C1, threadTs: "100.100" });
    await seed({ ...C1, threadTs: "200.200" });

    const result = await acquire({ ...C1, threadTs: "300.300" });

    expect(result.kind).toBe("needs_choice");
    if (result.kind !== "needs_choice") return;
    expect(result.candidates).toHaveLength(2);
  });

  it("asks the user to choose when multiple root investigations exist in the channel", async () => {
    await seed(C1);
    await seed(C1);

    const result = await acquire(C1);

    expect(result.kind).toBe("needs_choice");
    if (result.kind !== "needs_choice") return;
    expect(result.candidates).toHaveLength(2);
  });

  it("never reuses a resolved investigation", async () => {
    const resolved = await seed(C1);
    await service.resolveInvestigation(resolved.id, "U99999");

    const result = await acquire(C1);

    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.investigation.id).not.toBe(resolved.id);
  });

  it("never reuses an archived investigation", async () => {
    const archived = await seed(C1);
    await service.startInvestigation(archived.id);
    await service.changeStatus(archived.id, InvestigationStatus.Analyzing);
    await service.changeStatus(archived.id, InvestigationStatus.GeneratingFindings);
    await service.resolveInvestigation(archived.id, "U99999");
    await service.changeStatus(archived.id, InvestigationStatus.GeneratingRunbook);
    await service.changeStatus(archived.id, InvestigationStatus.WaitingApproval);
    await service.complete(archived.id);
    await service.archive(archived.id);
    expect(archived.status).toBe(InvestigationStatus.Archived);

    const result = await acquire(C1);

    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.investigation.id).not.toBe(archived.id);
  });

  it("creates a clean investigation when no conversation context is present", async () => {
    const result = await service.createOrAssociateInvestigation({
      title: "No conversation",
      description: "No conversation",
      severity: "medium",
      trigger: createTrigger("U123", { teamId: "", channelId: "", threadTs: "" }),
      createdBy: "U123",
    });

    expect(result.kind).toBe("created");
  });
});

describe("End-to-end: /investigate then @mention reuse (INV-001 never INV-002)", () => {
  let repository: IInvestigationRepository;
  let eventBus: InProcessEventBus;
  let timelineService: TimelineService;
  let service: InvestigationService;

  beforeEach(() => {
    repository = new MemoryRepository();
    eventBus = new InProcessEventBus();
    timelineService = new TimelineService();
    service = new InvestigationService(repository, eventBus, timelineService);
  });

  it("creates INV-001 via /investigate and reuses it on repeated mentions", async () => {
    const registry = new TriggerRegistry();
    registry.register(new SlackSlashCommandAdapter());
    registry.register(new SlackMentionAdapter());
    const factory = new TriggerFactory();
    const dispatcher = new TriggerDispatcher(service);

    const slashEvent = {
      command: "/investigate",
      text: "checkout API 500s",
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

    const slashTrigger = factory.create(
      registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand)!,
      slashEvent,
    );
    const slashResult = await dispatcher.dispatch(slashTrigger);
    expect(slashResult.success).toBe(true);
    const firstId = slashResult.investigationId;
    expect(firstId).toBeTruthy();

    const mentionEvent = (threadTs: string) => ({
      type: "app_mention",
      user: "U12345",
      text: "<@U_BOT_ID> investigate checkout API failures",
      ts: "1234567890.123456",
      channel: "C12345",
      thread_ts: threadTs,
      team: "T12345",
      api_app_id: "A12345",
    });

    const mentionAdapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention)!;
    const firstMention = await dispatcher.dispatch(
      factory.create(mentionAdapter, mentionEvent("1234567890.123450")),
      { associate: true },
    );
    expect(firstMention.success).toBe(true);
    expect(firstMention.associated).toBe(true);
    expect(firstMention.investigationId).toBe(firstId);

    const secondMention = await dispatcher.dispatch(
      factory.create(mentionAdapter, mentionEvent("1234567890.123450")),
      { associate: true },
    );
    expect(secondMention.success).toBe(true);
    expect(secondMention.investigationId).toBe(firstId);

    // Exactly ONE investigation ever existed - never an INV-002.
    const all = await repository.findActive();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(firstId);
    expect(firstMention.investigationId).not.toBe("");
  });
});
