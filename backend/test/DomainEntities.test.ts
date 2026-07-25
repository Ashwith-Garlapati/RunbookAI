import { describe, it, expect } from "vitest";
import { Finding, FindingStatus } from "../domains/investigation/Finding.js";
import { RunbookReference, RunbookStatus } from "../domains/investigation/RunbookReference.js";
import { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import { Trigger } from "../domains/investigation/Trigger.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import { InvestigationReport } from "../domains/investigation/InvestigationReport.js";
import { TimelineEvent } from "../domains/investigation/TimelineEvent.js";
import { TimelineEventType } from "../domains/investigation/TimelineEventType.js";

describe("Finding", () => {
  it("creates a finding with default status", () => {
    const finding = Finding.create({
      title: "Test Finding",
      summary: "Summary",
      confidence: 0.85,
      reasoning: "Reasoning",
      recommendation: "Recommendation",
    });

    expect(finding.title).toBe("Test Finding");
    expect(finding.status).toBe(FindingStatus.Draft);
    expect(finding.confidence).toBe(0.85);
    expect(finding.id).toBeDefined();
    expect(finding.createdAt).toBeInstanceOf(Date);
  });

  it("confirms a finding", () => {
    const finding = Finding.create({
      title: "Test Finding",
      summary: "Summary",
      confidence: 0.85,
      reasoning: "Reasoning",
      recommendation: "Recommendation",
    });

    finding.confirm();
    expect(finding.status).toBe(FindingStatus.Confirmed);
  });

  it("rejects a finding", () => {
    const finding = Finding.create({
      title: "Test Finding",
      summary: "Summary",
      confidence: 0.85,
      reasoning: "Reasoning",
      recommendation: "Recommendation",
    });

    finding.reject();
    expect(finding.status).toBe(FindingStatus.Rejected);
  });

  it("reconstitutes from persisted data", () => {
    const original = Finding.create({
      title: "Test Finding",
      summary: "Summary",
      confidence: 0.85,
      reasoning: "Reasoning",
      recommendation: "Recommendation",
    });

    const reconstituted = Finding.reconstitute({
      id: original.id,
      title: original.title,
      summary: original.summary,
      confidence: original.confidence,
      reasoning: original.reasoning,
      recommendation: original.recommendation,
      relatedEvidence: [],
      status: FindingStatus.Confirmed,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    });

    expect(reconstituted.id).toBe(original.id);
    expect(reconstituted.status).toBe(FindingStatus.Confirmed);
  });
});

describe("RunbookReference", () => {
  it("creates with pending status", () => {
    const runbook = RunbookReference.create();

    expect(runbook.status).toBe(RunbookStatus.Pending);
    expect(runbook.version).toBe(1);
    expect(runbook.id).toBeDefined();
    expect(runbook.generatedAt).toBeInstanceOf(Date);
  });

  it("creates with optional github URL", () => {
    const runbook = RunbookReference.create({
      githubUrl: "https://github.com/example/runbook",
    });

    expect(runbook.githubUrl).toBe("https://github.com/example/runbook");
  });

  it("marks as generated", () => {
    const runbook = RunbookReference.create();
    runbook.markGenerated();
    expect(runbook.status).toBe(RunbookStatus.Generated);
  });

  it("approves the runbook", () => {
    const runbook = RunbookReference.create();
    runbook.markGenerated();
    runbook.approve();
    expect(runbook.status).toBe(RunbookStatus.Approved);
  });

  it("publishes the runbook", () => {
    const runbook = RunbookReference.create();
    runbook.markGenerated();
    runbook.approve();
    runbook.publish("https://github.com/example/runbook");
    expect(runbook.status).toBe(RunbookStatus.Published);
    expect(runbook.githubUrl).toBe("https://github.com/example/runbook");
  });
});

describe("EvidenceItem", () => {
  it("creates evidence item", () => {
    const evidence = EvidenceItem.create({
      investigationId: "inv-1" as any,
      source: EvidenceSource.Slack,
      type: "slack_message",
      reference: "https://slack.com/message/123",
    });

    expect(evidence.investigationId).toBe("inv-1");
    expect(evidence.source).toBe(EvidenceSource.Slack);
    expect(evidence.type).toBe("slack_message");
    expect(evidence.collectedAt).toBeInstanceOf(Date);
    expect(evidence.id).toBeDefined();
  });

  it("includes metadata when provided", () => {
    const evidence = EvidenceItem.create({
      investigationId: "inv-1" as any,
      source: EvidenceSource.Slack,
      type: "slack_message",
      reference: "https://slack.com/message/123",
      metadata: { channel: "C12345", user: "U12345" },
    });

    expect(evidence.metadata).toEqual({ channel: "C12345", user: "U12345" });
  });

  it("reconstitutes from persisted data", () => {
    const original = EvidenceItem.create({
      investigationId: "inv-1" as any,
      source: EvidenceSource.Slack,
      type: "slack_message",
      reference: "https://slack.com/message/123",
    });

    const reconstituted = EvidenceItem.reconstitute({
      id: original.id,
      investigationId: original.investigationId,
      source: original.source,
      type: original.type,
      reference: original.reference,
      collectedAt: original.collectedAt,
      metadata: original.metadata,
    });

    expect(reconstituted.id).toBe(original.id);
    expect(reconstituted.source).toBe(EvidenceSource.Slack);
  });
});

describe("Trigger", () => {
  it("creates a trigger", () => {
    const trigger = Trigger.create({
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      actor: "U12345",
      payload: { channel: "C12345" },
    });

    expect(trigger.source).toBe(TriggerSource.Slack);
    expect(trigger.type).toBe(TriggerType.SlashCommand);
    expect(trigger.actor).toBe("U12345");
    expect(trigger.timestamp).toBeInstanceOf(Date);
    expect(trigger.id).toBeDefined();
  });
});

describe("InvestigationReport", () => {
  it("creates a report", () => {
    const report = InvestigationReport.create({
      investigationId: "inv-1" as any,
      summary: "Investigation summary",
      timeline: ["Event 1", "Event 2"],
      evidenceSummary: ["ev-1" as any],
      findings: ["find-1" as any],
      recommendations: ["Fix this", "Monitor that"],
    });

    expect(report.investigationId).toBe("inv-1");
    expect(report.summary).toBe("Investigation summary");
    expect(report.timeline).toEqual(["Event 1", "Event 2"]);
    expect(report.recommendations).toEqual(["Fix this", "Monitor that"]);
    expect(report.generatedAt).toBeInstanceOf(Date);
  });
});

describe("TimelineEvent", () => {
  it("creates a timeline event", () => {
    const event = TimelineEvent.create({
      investigationId: "inv-1" as any,
      type: TimelineEventType.InvestigationCreated,
      description: "Investigation created",
    });

    expect(event.investigationId).toBe("inv-1");
    expect(event.type).toBe(TimelineEventType.InvestigationCreated);
    expect(event.description).toBe("Investigation created");
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it("includes metadata when provided", () => {
    const event = TimelineEvent.create({
      investigationId: "inv-1" as any,
      type: TimelineEventType.StatusChanged,
      description: "Status changed",
      metadata: { from: "draft", to: "collecting_evidence" },
    });

    expect(event.metadata).toEqual({
      from: "draft",
      to: "collecting_evidence",
    });
  });
});
