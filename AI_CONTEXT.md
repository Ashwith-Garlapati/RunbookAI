# RunbookAI – AI Context & Architecture Guide

> **Purpose**
>
> This document exists primarily for AI coding agents (OpenCode, Claude Code, Cursor, Codex, Gemini CLI, etc.).
>
> Before making any code changes, read this file completely.
>
> Do **NOT** infer project architecture from the folder structure alone.
> This document defines the intended architecture and implementation direction.

---

# Project Vision

RunbookAI is **not** an AI runbook generator.

RunbookAI is an **AI Incident Investigation Platform**.

Its purpose is to help engineering teams investigate incidents by collecting evidence, reasoning over production context, generating findings, producing runbooks, and preserving operational knowledge.

The application should behave like an **AI SRE teammate**, not an AI text generator.

---

# Core Philosophy

Everything revolves around an **Investigation**.

Nothing should bypass the Investigation Domain.

Every integration must either:

- Create an Investigation
- Attach evidence to an Investigation
- Consume Investigation outputs

No service should directly call AI without going through the Investigation Domain.

---

# High-Level Architecture

```
Slack
GitHub
SigNoz
API
Manual Trigger

        │

        ▼

 Investigation Domain
        │
        ▼
 Investigation Service
        │
        ▼
 Investigation Aggregate
        │
        ▼
 Evidence
 Timeline
 Findings
 Report
 Runbook

        │
        ▼
 AI Investigation Engine

        │
        ▼
 GitHub
 Slack
 Future Integrations
```

---

# Investigation Domain

The Investigation Domain is the central bounded context.

It owns:

- Investigation lifecycle
- Evidence references
- Timeline
- Findings
- Runbook reference
- Investigation report
- Domain events

Nothing modifies Investigation state except InvestigationService.

---

# Investigation Lifecycle

Every investigation follows this lifecycle.

```
Draft

↓

CollectingEvidence

↓

Analyzing

↓

GeneratingFindings

↓

GeneratingRunbook

↓

WaitingApproval

↓

Completed

↓

Archived
```

No invalid transitions are allowed.

---

# Aggregate Root

The Investigation aggregate owns:

- metadata
- trigger
- evidence references
- findings
- timeline references
- runbook reference
- report reference
- lifecycle state

The aggregate never talks to MongoDB.

The aggregate never calls AI.

The aggregate never calls Slack.

The aggregate never calls GitHub.

The aggregate is pure business logic.

---

# Trigger System

Every investigation begins with a Trigger.

Supported trigger sources:

- Slack
- GitHub
- SigNoz
- API
- Manual
- Datadog (future)
- Grafana (future)
- Prometheus (future)
- PagerDuty (future)
- CloudWatch (future)

Every trigger becomes

```
Trigger

↓

InvestigationService.createInvestigation()
```

Never bypass this flow.

---

# Investigation Service

InvestigationService is the only orchestrator.

Responsibilities:

- create investigations
- change lifecycle
- attach evidence
- attach findings
- attach runbooks
- generate reports
- publish events

Controllers should never mutate Investigation directly.

---

# Evidence Model

Evidence is not owned by the Investigation.

The Investigation stores only references.

Evidence may come from:

- Slack
- GitHub
- SigNoz
- Datadog
- Grafana
- Kubernetes
- API
- Manual uploads

Future collectors populate EvidenceItem objects.

---

# Timeline

Every important domain action produces a timeline event.

Examples:

- Investigation Created
- Status Changed
- Evidence Added
- Finding Added
- Runbook Generated
- Report Generated
- Completed
- Archived

Timeline entries should be generated from domain events whenever possible.

---

# Findings

Findings are AI-derived conclusions.

Each Finding contains:

- title
- summary
- confidence
- reasoning
- recommendation
- supporting evidence

Findings should always reference evidence.

---

# Investigation Report

The report is the final output of an investigation.

It contains:

- summary
- timeline
- evidence summary
- findings
- recommendations
- runbook reference

The report is generated after investigation analysis.

---

# Runbook

Runbooks are outputs.

Runbooks are **not** the primary object of the system.

A runbook is generated from an Investigation.

Runbooks may later be:

- approved
- published to GitHub
- versioned

---

# AI Architecture

AI should never receive raw Slack messages directly.

Instead:

```
Evidence

↓

Context Builder

↓

Prompt Builder

↓

LLM

↓

Structured Output

↓

Findings

↓

Runbook

↓

Report
```

The Investigation Domain must stay independent of AI implementation.

---

# Connector Architecture

External systems must be implemented as connectors.

Examples:

- Slack Connector
- GitHub Connector
- SigNoz Connector
- Datadog Connector
- Grafana Connector
- Kubernetes Connector

Connectors should only:

- create Triggers
- collect Evidence

They must never contain business logic.

---

# Current MVP Scope

The current hackathon MVP focuses on:

- Slack integration
- GitHub integration
- Investigation Domain
- Investigation lifecycle
- Evidence references
- Timeline
- Findings
- Runbook generation
- GitHub publishing

SigNoz integration is the next major milestone.

---

# What Is NOT Implemented Yet

These are planned but intentionally incomplete:

- SigNoz connector
- Evidence collectors
- Context Builder
- AI Investigation Engine
- Root Cause Engine
- Knowledge Base
- Similar Incident Engine
- Multi-tenancy
- RBAC
- Billing
- Dashboard
- Audit system

Do not assume these exist.

---

# Development Rules

When modifying the codebase:

- Do not bypass InvestigationService.
- Do not place business logic inside controllers.
- Do not place business logic inside Slack handlers.
- Do not place business logic inside GitHub handlers.
- Do not place persistence logic inside domain entities.
- Keep the Investigation aggregate pure.
- Prefer composition over duplication.
- Maintain strict TypeScript typing.
- Preserve the bounded-context structure.

---

# Long-Term Vision

RunbookAI is evolving toward an **AI Operations Engineer**.

Future workflow:

```
Alert

↓

Create Investigation

↓

Collect Evidence

↓

Analyze Context

↓

Generate Findings

↓

Identify Root Cause

↓

Recommend Fixes

↓

Generate Runbook

↓

Publish Knowledge

↓

Learn From Incident
```

Every future feature should strengthen this workflow rather than introduce shortcuts around it.

---

# Principle

If a proposed change does not fit the Investigation-centric architecture, redesign it before implementing it.

The Investigation Domain is the source of truth for all operational workflows in RunbookAI.
