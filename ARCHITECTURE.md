# RunBook-AI — Architecture Map

Two bounded contexts, one process (modular monolith). No AI in the incident path.

Transport: Slack events arrive via **Socket Mode** when `SLACK_APP_TOKEN` is set
(`SocketModeReceiver` + Mongo-backed `authorize`), otherwise via the HTTP Events
API receiver. OAuth install/callback is always served by `ExpressReceiver`.
Bot tokens are encrypted at rest; `botId` is stored at install time.

## Request flows

**Slack mention / command (investigation, legacy)**

```
Slack → handlers/SlackHandlers.ts → domains/trigger/* (Registry → Adapter → Factory → Validator → Dispatcher)
  → domains/investigation/InvestigationService.ts (sole mutator)
  → infrastructure/Mongo*Repository.ts → InProcessEventBus → TimelineHandler / SlackCardHandler
```

**Slack incident coordination (`/inc`, buttons, modals)**

```
Slack → ack fast → slack/SlackGateway.ts (dedupe event_id → in-process queue → retry w/ backoff, 429-aware)
  → domains/incident/IncidentCoordinator.ts (membership → authorize → mutate → persist → publish)
  → infrastructure/MongoIncidentRepository.ts → domains/incident/IncidentBus
  → handlers/IncidentTimelineHandler.ts (audit log + notify + control-message refresh)
```

**REST (web fallback, dev headers `x-team-id` / `x-user-id`)**

```
api/incidents.routes.ts → IncidentCoordinator (same auth/state as Slack — never direct DB)
```

**GitHub hotfix-PR flow (legacy, standalone, bypasses Investigation — do not copy this pattern)**

```
index.ts POST /github/webhook → services/githubWebhook.ts → services/aiEngine.ts (Gemini)
  → services/githubPublisher.ts → PR comment → approve/reject → RunbookModel + docs/runbooks/
```

## Module map

| Path | Owns |
|---|---|
| `domains/investigation/` | Pure aggregate (`Investigation`), lifecycle, evidence/finding/report/runbook value objects, timeline |
| `domains/trigger/` | Slack → `Trigger` pipeline (adapters per entry point) |
| `domains/incident/` | `Incident` aggregate, 8-state lifecycle, SEV-1–4, roles, permissions matrix, `IncidentCoordinator` |
| `slack/` | Gateway, channel manager, control message + modals (Block Kit), `/inc` handlers, token crypto |
| `handlers/` | EventBus subscribers (timeline, cards, audit, logging — no business logic) |
| `services/` | Slack helpers (intent, Q&A templates, cards); legacy GitHub/AI modules |
| `infrastructure/` | `EventBus` base, `InProcessEventBus`, Mongo repositories, idempotency store |
| `models/` | Mongoose schemas (`incidents` holds subdocuments; timeline/activity append-only by convention) |
| `api/` | Express routers over the coordinator |
| `observability/` | Structured JSON logger (secret-redacting) + correlation IDs |

## Lifecycles

- Investigation: `draft → collecting_evidence → analyzing → generating_findings → resolved → generating_runbook → waiting_approval → completed → archived` (+ `resolved → collecting_evidence` reopen).
- Incident: `detected → investigating → identified → mitigating → monitoring → resolved → closed`, plus `→ cancelled → closed` from any open state. `resolve()`/`cancel()` accept any open state; manual `changeStatus()` enforces the matrix.

## Invariants (do not break)

1. Only `InvestigationService` mutates investigations; only `IncidentCoordinator` mutates incidents.
2. Aggregates never touch Mongo/Slack/AI (only `node:crypto`).
3. Identity = internal ID + Slack channel **ID** (names are display-only).
4. Slack identity is never trusted alone — membership → server-side permission matrix.
5. Timeline entries are never rewritten; incidents are never deleted (cancel preserves history).
6. Every Slack mutation carries an idempotency key; duplicate deliveries return current state.
