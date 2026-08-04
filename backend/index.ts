import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { App, ExpressReceiver, type Installation } from "@slack/bolt";
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
    postStatusComment
} from "./services/githubPublisher.js";

import { MongoInvestigationRepository } from "./infrastructure/MongoInvestigationRepository.js";
import { MongoTimelineRepository } from "./infrastructure/MongoTimelineRepository.js";
import { MongoFindingRepository } from "./infrastructure/MongoFindingRepository.js";
import { MongoReportRepository } from "./infrastructure/MongoReportRepository.js";
import { MongoRunbookReferenceRepository } from "./infrastructure/MongoRunbookReferenceRepository.js";
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

if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is required");
    process.exit(1);
}

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});

const connectDB = async () => {
    await mongoose.connect(process.env.MONGODB_URI || "").then(() => {
        console.log("✓ Mongo Connected");
    }).catch(async (error) => {
        console.log("Failed to connect to MongoDB", error);
        process.exit(1);
    });
}

const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET || "",
    clientId: process.env.SLACK_CLIENT_ID || "",
    clientSecret: process.env.SLACK_CLIENT_SECRET || "",
    stateSecret: 'runbookai-state-secret',
    scopes: [
        'channels:history',
        'channels:manage',
        'groups:history',
        'chat:write',
        'im:write',
        'users:read',
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
                        botToken: installation.bot?.token,
                        botUserId: installation.bot?.userId,
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
                    token: doc.botToken,
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

console.log("✓ ExpressReceiver Initialized");

const bolt = new App({ receiver });

app.use(receiver.app);

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
// TODO(Runbook Phase): Runbook generation, approval DMs, and the legacy
// incident-tracking flows (services/slackChannelManager.ts,
// services/slackModal.ts, approve/reject actions, /runbook search,
// /runbook github-link, /runbook resolve) belong to later phases and are
// not registered here.

const start = async () => {
    await connectDB();

    // ---- Repositories ----
    const investigationRepo = new MongoInvestigationRepository();
    const timelineRepo = new MongoTimelineRepository();
    const findingRepo = new MongoFindingRepository();
    const reportRepo = new MongoReportRepository();
    const runbookRefRepo = new MongoRunbookReferenceRepository();

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
        findingRepo,
        reportRepo,
        runbookRefRepo,
    );

    console.log("✓ Investigation Domain Initialized");

    // ---- Trigger Layer (initialized once at startup) ----
    const triggerRegistry = new TriggerRegistry();
    triggerRegistry.register(new SlackSlashCommandAdapter());
    triggerRegistry.register(new SlackShortcutAdapter());
    triggerRegistry.register(new SlackMentionAdapter());

    const triggerValidator = new TriggerValidator();
    const triggerFactory = new TriggerFactory(triggerValidator);
    const triggerDispatcher = new TriggerDispatcher(investigationService);

    console.log("✓ Trigger Layer Initialized");

    // ---- Slack Handlers (no business logic; delegates to Trigger Layer) ----
    registerSlackHandlers(bolt, {
        registry: triggerRegistry,
        factory: triggerFactory,
        dispatcher: triggerDispatcher,
    });

    console.log("✓ Slack Handlers Registered");

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
                const comments = await octokit.issues.listComments({
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

    app.listen(PORT, () => {
        console.log(`✓ Server Listening on port ${PORT}`);
    });
};

start();
