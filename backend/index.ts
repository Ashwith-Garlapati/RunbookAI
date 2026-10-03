import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { App, ExpressReceiver, SocketModeReceiver, type Installation } from "@slack/bolt";
import { Octokit } from "@octokit/rest";

import InstallationModel from "./models/Installation.model.js";
import { generateRunbookFromPR, type GeneratedPRRunbook } from "./services/aiEngine.js";
import { RunbookModel } from "./models/Runbook.model.js";
import {
    isHotfixPR,
    verifyGitHubSignature,
    extractPRData
} from "./services/githubWebhook.js";
import {
    publishToGitHub,
    postRunbookComment,
    deleteComment,
    postStatusComment,
    isGitHubEnabled
} from "./services/githubPublisher.js";

import { MongoInvestigationRepository } from "./infrastructure/MongoInvestigationRepository.js";
import { MongoTimelineRepository } from "./infrastructure/MongoTimelineRepository.js";
import { InProcessEventBus } from "./infrastructure/InProcessEventBus.js";
import { InvestigationService } from "./domains/investigation/InvestigationService.js";
import { TimelineService } from "./domains/investigation/TimelineService.js";
import { AuditEventHandler } from "./handlers/AuditEventHandler.js";
import { TimelineHandler } from "./handlers/TimelineHandler.js";
import { LoggingHandler } from "./handlers/LoggingHandler.js";

// Trigger Layer imports
import { TriggerRegistry } from "./domains/trigger/TriggerRegistry.js";
import { TriggerFactory } from "./domains/trigger/TriggerFactory.js";
import { TriggerValidator } from "./domains/trigger/TriggerValidator.js";
import { TriggerDispatcher } from "./domains/trigger/TriggerDispatcher.js";
import { SlackSlashCommandAdapter } from "./domains/trigger/adapters/SlackSlashCommandAdapter.js";
import { SlackShortcutAdapter } from "./domains/trigger/adapters/SlackShortcutAdapter.js";
import { SlackMentionAdapter } from "./domains/trigger/adapters/SlackMentionAdapter.js";
import { registerSlackHandlers } from "./handlers/SlackHandlers.js";
import { MentionIntentDetector } from "./services/MentionIntentDetector.js";
import { QuestionAnsweringService } from "./services/QuestionAnsweringService.js";
import { SlackCardHandler } from "./handlers/SlackCardHandler.js";

// Incident Coordination Layer (deterministic, no AI)
import { IncidentBus } from "./domains/incident/IncidentBus.js";
import { IncidentCoordinator } from "./domains/incident/IncidentCoordinator.js";
import { DefaultMembershipResolver } from "./domains/incident/IncidentRepository.js";
import { MongoIncidentRepository, MongoIdempotencyStore } from "./infrastructure/MongoIncidentRepository.js";
import { SlackGateway, startRecoveryLoop } from "./slack/SlackGateway.js";
import { registerIncidentSlackHandlers } from "./slack/IncidentSlackHandlers.js";
import { registerSlackEvidenceIngest } from "./slack/slackEvidenceIngest.js";
import { CommonEvidenceStore } from "./services/commonEvidenceStore.js";
import { MongoEvidenceRepository } from "./infrastructure/MongoEvidenceRepository.js";
import { IncidentAuditHandler, IncidentNotifier } from "./handlers/IncidentTimelineHandler.js";
import { createSlackClientProvider } from "./slack/slackClientProvider.js";
import { createIncidentsRouter } from "./api/incidents.routes.js";
import { createTeamConfigRouter } from "./api/teamConfig.routes.js";
import { MongoJobStore } from "./infrastructure/MongoJobStore.js";
import { IncidentJobModel } from "./models/IncidentOps.model.js";
import { runIncidentJob, type IncidentJobOp } from "./slack/incidentJobs.js";
import { startUpdateReminderLoop } from "./slack/updateReminder.js";
import { encryptToken, decryptToken } from "./slack/tokenCrypto.js";
import { createSlackAuthorize } from "./slack/slackAuthorize.js";
import { IncidentModel } from "./models/Incident.model.js";
import { SlackProcessedEventModel, AuditLogModel } from "./models/IncidentOps.model.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use((req, res, next) => {
    if (req.path.startsWith("/slack/") || req.path === "/github/webhook") {
        next();
    } else {
        express.json()(req, res, next);
    }
});

app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", service: "runbookai-backend" });
});

const githubEnabled = isGitHubEnabled();
if (!githubEnabled) {
    console.warn("⚠ GITHUB_TOKEN not set — GitHub webhook flow disabled; running in Slack-only mode");
}

const getOctokit = (): Octokit => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("GITHUB_TOKEN is not set — GitHub operations are disabled");
    }
    return new Octokit({ auth: token });
};

const connectDB = async () => {
    await mongoose.connect(process.env.MONGODB_URI || "").then(() => {
        console.log("✓ Mongo Connected");
    }).catch(async (error) => {
        console.log("Failed to connect to MongoDB", error);
        process.exit(1);
    });
}

const expressReceiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET || "",
    clientId: process.env.SLACK_CLIENT_ID || "",
    clientSecret: process.env.SLACK_CLIENT_SECRET || "",
    stateSecret: process.env.SLACK_STATE_SECRET || 'runbookai-state-secret',
    scopes: [
        'channels:history',
        'channels:read',
        'channels:manage',
        'groups:history',
        'groups:read',
        'chat:write',
        'im:write',
        'users:read',
        'pins:write',
        'commands',
        'app_mentions:read'
    ],

    installationStore: {

        storeInstallation: async (installation: Installation) => {
            const teamId = installation.team?.id;
            if (!teamId) {
                throw new Error("Missing team id in installation");
            }
            await InstallationModel.findOneAndUpdate(
                { teamId },
                {
                    $set: {
                        teamId,
                        teamName: installation.team?.name,
                        botToken: installation.bot?.token ? encryptToken(installation.bot.token) : undefined,
                        botUserId: installation.bot?.userId,
                        botId: installation.bot?.id,
                    },
                },
                { upsert: true, new: true }
            );
            console.log(`Workspace Installed: ${installation.team?.name}`);
        },

        fetchInstallation: async (installQuery) => {
            const teamId = installQuery.teamId;
            if (!teamId) {
                throw new Error("Missing teamId in install query");
            }
            const doc = await InstallationModel.findOne({ teamId });
            if (!doc) {
                throw new Error(`Installation not found for team ${teamId}`);
            }
            return {
                team: {
                    id: doc.teamId,
                    name: doc.teamName
                },
                bot: {
                    token: decryptToken(doc.botToken),
                    userId: doc.botUserId,
                    scopes: [],
                    id: doc.botUserId
                },
                user: { id: '', token: '', scopes: [] }
            } as unknown as Installation;
        },

        deleteInstallation: async (installQuery) => {
            const teamId = installQuery.teamId;
            if (!teamId) {
                throw new Error("Missing teamId in install query");
            }
            await InstallationModel.deleteOne({
                teamId
            });
            console.log(`Workspace uninstalled: ${installQuery.teamId}`);
        }
    },
});

console.log("✓ ExpressReceiver Initialized (OAuth)");

// ExpressReceiver always serves the OAuth install/callback routes.
// Events arrive via Socket Mode when SLACK_APP_TOKEN is set, otherwise via
// the HTTP receiver (Slack Events API webhook).
app.use(expressReceiver.app);

const useSocketMode = Boolean(process.env.SLACK_APP_TOKEN);
if (useSocketMode) {
    console.log("✓ Slack Socket Mode enabled (events over WebSocket)");
} else {
    console.warn("⚠ SLACK_APP_TOKEN not set — falling back to HTTP Events API; set it to use Socket Mode");
}

const installationLookup = {
    findByTeam: async (teamId: string) => {
        const doc = await InstallationModel.findOne({ teamId }).lean();
        if (!doc) return null;
        return {
            teamId: doc.teamId,
            teamName: doc.teamName ?? undefined,
            botToken: doc.botToken,
            botUserId: doc.botUserId ?? "",
            botId: doc.botId ?? null,
        };
    },
};

const bolt = useSocketMode
    ? new App({
        receiver: new SocketModeReceiver({ appToken: process.env.SLACK_APP_TOKEN as string }),
        authorize: createSlackAuthorize({
            lookup: installationLookup,
            decrypt: decryptToken,
        }),
    })
    : new App({ receiver: expressReceiver });

// =====================================================================
// Trigger Layer
// =====================================================================
//
// All Slack investigation triggers are registered in handlers/SlackHandlers.ts.
// The Trigger Layer STOPS after InvestigationService.createInvestigation():
//
//   Slack Event → Handler → Registry → Adapter → Factory → Validator → Dispatcher → InvestigationService
//
// Nothing else happens. No AI. No runbook. No Slack thread reading.
// No GitHub publishing. No approval DM.
//
// TODO(Evidence Layer): The next phase owns collecting Slack threads
// (services/slackReader.ts), GitHub context, and other evidence sources
// before invoking the AI Investigation Engine (services/aiEngine.ts).
// Those services are intentionally NOT called from the trigger flow.
//
// TODO(Runbook Phase): Runbook generation, approval DMs, and runbook
// search / github-link / resolve flows belong to later phases and are
// not registered here. There is no /runbook slash command.

const start = async () => {
    await connectDB();

    // ---- Repositories ----
    const investigationRepo = new MongoInvestigationRepository();
    const timelineRepo = new MongoTimelineRepository();

    // ---- Event Bus ----
    const eventBus = new InProcessEventBus();
    const timelineService = new TimelineService(timelineRepo);

    // ---- Event Handlers ----
    const auditHandler = new AuditEventHandler();
    const loggingHandler = new LoggingHandler();
    const timelineHandler = new TimelineHandler(timelineService);

    eventBus.subscribe("*", auditHandler);
    eventBus.subscribe("*", loggingHandler);
    eventBus.subscribe("*", timelineHandler);

    console.log("✓ Event Bus Initialized");

    // ---- Investigation Domain ----
    const investigationService = new InvestigationService(
        investigationRepo,
        eventBus,
        timelineService,
    );

    console.log("✓ Investigation Domain Initialized");

    // ---- Mention Assistant (intent detection + question answering) ----
    const intentDetector = new MentionIntentDetector();
    const questionService = new QuestionAnsweringService(investigationService);

    console.log("✓ Mention Assistant Initialized");

    // ---- Trigger Layer (initialized once at startup) ----
    const triggerRegistry = new TriggerRegistry();
    triggerRegistry.register(new SlackSlashCommandAdapter());
    triggerRegistry.register(new SlackShortcutAdapter());
    triggerRegistry.register(new SlackMentionAdapter());

    const triggerValidator = new TriggerValidator();
    const triggerFactory = new TriggerFactory(triggerValidator);
    const triggerDispatcher = new TriggerDispatcher(investigationService);

    console.log("✓ Trigger Layer Initialized");

    // ---- TEMPORARY DIAGNOSTIC (remove after shortcut debugging) ----
    // Logs every inbound Slack envelope BEFORE listener matching: type,
    // callback_id, team and user IDs only. Never tokens/secrets/payloads.
    bolt.use(async ({ body, next }) => {
        try {
            const b = body as unknown as {
                type?: unknown;
                callback_id?: unknown;
                team?: { id?: unknown } | unknown;
                team_id?: unknown;
                user?: { id?: unknown } | unknown;
                api_app_id?: unknown;
            };
            const team =
                (typeof b.team === "object" && b.team !== null ? (b.team as { id?: unknown }).id : undefined) ??
                b.team_id;
            const user = typeof b.user === "object" && b.user !== null ? (b.user as { id?: unknown }).id : b.user;
            console.log(
                `[SlackDiag] type=${String(b.type ?? "?")} callback=${String(b.callback_id ?? "-")} ` +
                    `team=${String(team ?? "?")} user=${String(user ?? "?")} app=${String(b.api_app_id ?? "?")}`,
            );
        } catch {
            // Diagnostic must never break event flow.
        }
        await next();
    });

    // ---- Slack Handlers (no business logic; delegates to Trigger Layer) ----
    registerSlackHandlers(bolt, {
        registry: triggerRegistry,
        factory: triggerFactory,
        dispatcher: triggerDispatcher,
        investigationService,
        intentDetector,
        questionService,
    });

    console.log("✓ Slack Handlers Registered");

    // =====================================================================
    // Incident Coordination Layer (deterministic, no AI)
    // =====================================================================
    await IncidentModel.ensureIndexes().catch((e) => console.warn("Incident index ensure failed:", e));
    await SlackProcessedEventModel.ensureIndexes().catch((e) => console.warn("Processed-event index ensure failed:", e));
    await AuditLogModel.ensureIndexes().catch((e) => console.warn("Audit index ensure failed:", e));
    await IncidentJobModel.ensureIndexes().catch((e) => console.warn("Job index ensure failed:", e));

    const incidentRepo = new MongoIncidentRepository();
    const idempotencyStore = new MongoIdempotencyStore();
    const membership = new DefaultMembershipResolver(
        (process.env.INCIDENT_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        (process.env.INCIDENT_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    );
    const incidentBus = new IncidentBus();
    const coordinator = new IncidentCoordinator(incidentRepo, incidentBus, idempotencyStore, membership);

    // Per-workspace authorized Slack clients. bolt.client at startup carries
    // no token under Socket Mode (custom authorize), so background and
    // event-driven code must resolve team clients here (not_authed otherwise).
    const slackClients = createSlackClientProvider({
        lookup: installationLookup,
        decrypt: decryptToken,
    });

    const resolveDefaultCommander = async (teamId: string): Promise<string | null> => {
        const doc = await InstallationModel.findOne({ teamId }).lean();
        return doc?.defaultCommanderId ?? doc?.defaultLeadId ?? null;
    };

    // Durable incident jobs: persisted before the first run, replayed on boot.
    const jobStore = new MongoJobStore();
    const incidentJobCtx = { coordinator, clients: slackClients, resolveDefaultCommander };
    const incidentGateway = new SlackGateway(idempotencyStore, {
        store: jobStore,
        dispatch: (d) => runIncidentJob(incidentJobCtx, { key: d.key, op: d.op as IncidentJobOp, teamId: d.teamId, params: d.params }),
    });

    incidentBus.subscribe("*", new IncidentAuditHandler());
    incidentBus.subscribe("*", new IncidentNotifier(coordinator, slackClients));

    // ---- Investigation incident card (update on resolve, unpin on runbook) ----
    // Event-driven like everything else; resolves its own workspace client
    // per event (the startup-global bolt.client carries no Socket Mode token).
    eventBus.subscribe("*", new SlackCardHandler(slackClients, investigationService));
    console.log("✓ Investigation Card Handler Initialized");

    registerIncidentSlackHandlers(bolt, {
        coordinator,
        gateway: incidentGateway,
        jobs: incidentJobCtx,
        membership,
        resolveDefaultCommander,
    });

    // Slack evidence live ingest (same Bolt app, channel-scoped, investigation-gated).
    registerSlackEvidenceIngest(bolt, {
        gateway: incidentGateway,
        coordinator,
        store: new CommonEvidenceStore(new MongoEvidenceRepository()),
        clients: slackClients,
    });

    app.use("/api/incidents", createIncidentsRouter({ coordinator }));
    app.use("/api/team", createTeamConfigRouter({ membership }));

    // Crash recovery BEFORE accepting traffic: reclaim the previous
    // process's leases immediately, then sweep periodically for jobs
    // rescheduled with a future notBefore or orphaned by later crashes.
    // Handlers stay idempotent so replays converge.
    await incidentGateway.recover({ reclaimLeased: true }).catch((e) => {
        console.warn("Job recovery failed:", e instanceof Error ? e.message : String(e));
    });
    console.log("✓ Incident Job Recovery Complete");
    startRecoveryLoop(incidentGateway);

    startUpdateReminderLoop({
      incidentRepo,
      listTeams: async () => {
        const docs = await InstallationModel.find({}).select("teamId").lean();
        return docs.map((d) => d.teamId);
      },
      clients: slackClients,
    });
    console.log("✓ Update Reminders Started");

    console.log("✓ Incident Coordination Layer Initialized");

    // =====================================================================
    // GitHub Webhook (hotfix PR runbooks - standalone legacy flow)
    // =====================================================================
    app.post("/github/webhook", express.raw({ type: "application/json" }), async (req, res) => {

        const signature = req.headers["x-hub-signature-256"] as string;
        if (!signature) { res.status(401).send("Unauthorized"); return; }

        const isValid = verifyGitHubSignature(req.body.toString(), signature);
        if (!isValid) { res.status(401).send("Unauthorized"); return; }

        let payload;
        try {
            payload = JSON.parse(req.body.toString());
        } catch (e) {
            res.status(400).send("Bad Request");
            return;
        }

        const event = req.headers["x-github-event"];
        console.log(`📦 GitHub event received: ${event}`);

        if (!githubEnabled) {
            console.log("GitHub flow disabled (no GITHUB_TOKEN) — skipping");
            res.status(200).send("OK");
            return;
        }

        if (event === "issue_comment" && payload.action === "created") {
            const commentBody = payload.comment?.body?.trim().toLowerCase();
            const commenter = payload.comment?.user?.login;
            const prNumber = payload.issue?.number;
            const repoOwner = payload.repository?.owner?.login;
            const repoName = payload.repository?.name;

            if (commentBody !== "approve" && commentBody !== "reject") {
                res.status(200).send("OK");
                return;
            }

            if (payload.comment?.user?.type === "Bot") {
                res.status(200).send("OK");
                return;
            }

            res.status(200).send("OK");

            try {
                const comments = await getOctokit().issues.listComments({
                    owner: repoOwner,
                    repo: repoName,
                    issue_number: prNumber,
                    per_page: 100
                });

                const runbookComment = comments.data.find(c =>
                    c.body?.includes("<!--RUNBOOK_DATA:")
                );

                if (!runbookComment) {
                    console.log(`No RunbookAI comment found on PR #${prNumber}`);
                    return;
                }

                const match = runbookComment.body?.match(/<!--RUNBOOK_DATA:(.*?)-->/s);
                if (!match) {
                    console.log("Could not extract runbook data");
                    return;
                }

                const runbook = JSON.parse(match[1] ?? "{}") as GeneratedPRRunbook;
                if (!runbook.title || !runbook.severity) {
                    console.log("Invalid runbook data extracted");
                    return;
                }
                console.log(`Extracted runbook: ${runbook.title}`);

                if (commentBody === "approve") {
                    console.log(`✅ ${commenter} approved the runbook`);

                    // Look up the Slack team linked to this GitHub org
                    const linkedInstallation = repoOwner ? await InstallationModel.findOne({
                        githubOrgs: repoOwner.toLowerCase()
                    }) : null;
                    const teamId = linkedInstallation?.teamId;
                    if (!teamId) {
                        console.log(`⚠️ No Slack workspace linked to GitHub org "${repoOwner}" — runbook will not be searchable via Slack`);
                    }

                    await RunbookModel.create({
                        ...(teamId ? { teamId } : {}),
                        title: runbook.title,
                        severity: runbook.severity,
                        overview: runbook.overview,
                        rootCause: runbook.rootCause,
                        actionsTaken: runbook.actionsTaken,
                        preventionSteps: runbook.preventionSteps,
                        keyEvents: runbook.keyEvents || [],
                        owner: runbook.owner,
                        approvedBy: commenter,
                        source: "github_pr"
                    });
                    console.log("💾 Saved to MongoDB");

                    let githubUrl = null;
                    try {
                        githubUrl = await publishToGitHub(runbook, commenter, repoOwner, repoName);
                        console.log("🐙 Published to GitHub:", githubUrl);
                    } catch (error) {
                        console.error("GitHub publish failed:", error);
                    }

                    await postStatusComment(
                        prNumber, "approved",
                        runbook.title, githubUrl,
                        repoOwner, repoName
                    );

                } else if (commentBody === "reject") {
                    console.log(`❌ ${commenter} rejected the runbook`);

                    await postStatusComment(
                        prNumber, "rejected",
                        runbook.title, null,
                        repoOwner, repoName
                    );
                }

                await deleteComment(runbookComment.id, repoOwner, repoName);

            } catch (error) {
                console.error("Error processing comment:", error);
            }

            return;
        }

        if (event !== "pull_request" || payload.action !== "closed" || !payload.pull_request?.merged) {
            res.status(200).send("OK");
            return;
        }

        console.log(`PR merged: "${payload.pull_request.title}"`);

        const prData = extractPRData(payload);

        if (!isHotfixPR(prData)) {
            console.log("PR is not a hotfix — skipping");
            res.status(200).send("OK");
            return;
        }

        console.log("Hotfix PR detected — generating runbook...");
        res.status(200).send("OK");

        try {
            const runbook = await generateRunbookFromPR(prData);

            if (!runbook) {
                console.log("Failed to generate runbook from PR");
                return;
            }

            console.log("Runbook generated from PR:", runbook.title);

            // ✅ CHANGED — post as PR comment instead of Slack DM only
            await postRunbookComment(
                payload.pull_request.number,
                runbook,
                prData.repoOwner,
                prData.repoName
            );

            console.log("📨 Runbook comment posted on PR");

        } catch (error) {
            console.error("Error processing GitHub webhook:", error);
        }
    });

    console.log("✓ GitHub Webhook Registered");

    if (useSocketMode) {
        // SocketModeReceiver only opens its WebSocket on start() — without
        // this, boot logs look fine but no Slack events ever arrive.
        await bolt.start();
        console.log("✓ Slack Socket Mode connected");
    }

    app.listen(PORT, () => {
        console.log(`✓ Server Listening on port ${PORT} → http://localhost:${PORT}`);
        console.log(`✓ Health check: http://localhost:${PORT}/healthz`);
    });
};

start();
