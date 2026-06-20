import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { WebClient } from "@slack/web-api";
import { App, type Installation } from "@slack/bolt";
import { Octokit } from "@octokit/rest";

import InstallationModel from "./models/Installation.model.js";
import { generateRunbook, type GeneratedPRRunbook } from "./services/aiEngine.js";
import { detectionIncident } from "./services/aiEngine.js";
import { readFullThread } from "./services/slackReader.js";
import { RunbookModel } from "./models/Runbook.model.js";
import { searchRunbooks, findSimilarRunbooks } from "./services/runbookSearch.js";
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
import { generateRunbookFromPR } from "./services/aiEngine.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use((req, res, next) => {
    if (req.path === "/github/webhook") {
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
        console.log("Connected to MongoDB");
    }).catch(async (error) => {
        console.log("Failed to connect to MongoDB", error);
        process.exit(1);
    });
}

const bolt = new App({
    signingSecret: process.env.SLACK_SIGNING_SECRET || "",
    clientId: process.env.SLACK_CLIENT_ID || "",
    clientSecret: process.env.SLACK_CLIENT_SECRET || "",
    stateSecret: 'runbookai-state-secret',
    scopes: [
        'channels:history',
        'groups:history',
        'chat:write',
        'im:write',
        'users:read'
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
            console.log(`[DEBUG] fetchInstallation called for teamId: ${teamId}`);
            if (!teamId) {
                throw new Error("Missing teamId in install query");
            }
            const doc = await InstallationModel.findOne({ teamId });
            if (!doc) {
                console.log(`[DEBUG] No installation found for ${teamId}`);
                throw new Error(`Installation not found for team ${teamId}`);
            }
            console.log(`[DEBUG] Found installation for team: ${doc.teamName} (${doc.teamId})`);
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

bolt.event("message", async ({ event, say }) => {
    // console.log("RAW EVENT RECEIVED:", JSON.stringify(event));
    if (event.subtype !== undefined) {
        return;
    }

    const text = event.text ?? "";
    const user = event.user;
    const channel = event.channel;

    if (!text || text.length < 5) return;
    if (!user || user === "") return;

    const detection = await detectionIncident(text);

    console.log(`🔍 Detection: isIncident=${detection.isIncident}, isResolved=${detection.isResolved}, confidence=${detection.confidence}`);
    console.log(`Reason: ${detection.reason}`);

    if (!detection.isIncident || detection.confidence < 0.7) {
        return;
    }

    if (!detection.isResolved) {
        try {
            const teamId = event.team;
            if (!teamId) return;
            const installation = await InstallationModel.findOne({ teamId });
            if (!installation) return;

            const token = installation.botToken;

            const similarRunbooks = await findSimilarRunbooks(
                text,
                detection.incidentType,
                teamId
            );

            if (similarRunbooks.length === 0) {
                console.log("No similar past incidents found");
                return;
            }

            console.log(`📚 Found ${similarRunbooks.length} similar past incidents — posting to channel`);

            const webClient = new WebClient(token);

            const similarBlocks: any[] = [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `🔁 *RunbookAI — Similar past incident${similarRunbooks.length > 1 ? "s" : ""} found*\n\nThis might help resolve the current incident faster:`
                    }
                },
                { type: "divider" }
            ];

            similarRunbooks.forEach((runbook, index) => {
                const severityEmoji = {
                    high: "🔴",
                    medium: "🟡",
                    low: "🟢"
                }[runbook.severity?.toLowerCase()] || "⚪";

                const date = runbook.createdAt
                    ? new Date(runbook.createdAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric"
                    })
                    : "Unknown date";

                similarBlocks.push({
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*${index + 1}. ${runbook.title}*`
                        },
                        {
                            type: "mrkdwn",
                            text: `${severityEmoji} ${runbook.severity?.toUpperCase()} — ${date}`
                        }
                    ]
                });

                similarBlocks.push({
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Root Cause:* ${runbook.rootCause || "Not specified"}`
                    }
                });

                if (runbook.actionsTaken?.length > 0) {
                    const actions = runbook.actionsTaken
                        .map((action: string, i: number) => `${i + 1}. ${action}`)
                        .join("\n");

                    similarBlocks.push({
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*How it was fixed:*\n${actions}`
                        }
                    });
                }

                if (runbook.preventionSteps?.length > 0) {
                    const steps = runbook.preventionSteps
                        .map((step: string, i: number) => `${i + 1}. ${step}`)
                        .join("\n");

                    similarBlocks.push({
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Prevention steps:*\n${steps}`
                        }
                    });
                }

                if (index < similarRunbooks.length - 1) {
                    similarBlocks.push({ type: "divider" });
                }
            });

            await webClient.chat.postMessage({
                channel,
                text: `🔁 RunbookAI found ${similarRunbooks.length} similar past incident(s)`,
                blocks: similarBlocks
            });

            console.log("✅ Similar runbooks posted to channel");

        } catch (error) {
            console.error("Error finding similar runbooks:", error);
        }

        return;
    }

    console.log(`🔥 ${detection.incidentType.toUpperCase()} incident resolved — generating runbook...`);

    try {
        const teamId = event.team;
        if (!teamId) {
            console.log("No teamId found in event");
            return;
        }

        const installation = await InstallationModel.findOne({ teamId });
        if (!installation) {
            console.log("No installation found for team", teamId);
            return;
        }
        const botToken = installation.botToken;

        console.log("📖 Reading full Slack thread...");
        const messages = await readFullThread(botToken, channel);

        if (messages.length === 0) {
            console.log("No messages found");
            return;
        }

        console.log("🤖 Sending to Gemini AI...");
        const runbook = await generateRunbook(messages, channel);

        if (!runbook) {
            console.log("Failed to generate runbook");
            return;
        }

        console.log("✅ Runbook generated:", runbook);

        let approvalTarget = user;

        if (runbook.owner) {
            const ownerFromThread = messages.find((msg: string) =>
                msg.toLowerCase().includes(runbook.owner.toLowerCase())
            );

            if (ownerFromThread) {
                const ownerId = ownerFromThread.split(":")[0]?.trim();
                if (ownerId && ownerId.startsWith("U")) {
                    approvalTarget = ownerId;
                    console.log(`📨 Sending to Gemini-identified owner: ${ownerId}`);
                }
            }
        }

        if (approvalTarget === user) {
            const messageCounts = new Map<string, number>();
            messages.forEach(msg => {
                const userId = msg.split(":")[0]?.trim();
                if (userId?.startsWith("U")) {
                    messageCounts.set(userId, (messageCounts.get(userId) || 0) + 1);
                }
            });

            let maxCount = 0;
            messageCounts.forEach((count, userId) => {
                if (count > maxCount) {
                    maxCount = count;
                    approvalTarget = userId;
                }
            });
        }

        const client = new WebClient(botToken as string);

        await client.chat.postMessage({
            channel: approvalTarget,
            text: 'RunbookAI — Runbook Draft Ready',
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `🤖 *RunbookAI detected an incident resolution*\n\nHere is your generated runbook:`
                    }
                },
                {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*Title:*\n${runbook.title}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Severity:*\n${runbook.severity}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Root Cause:*\n${runbook.rootCause}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Overview:*\n${runbook.overview}`
                        }
                    ]
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: { type: "plain_text", text: "✅ Approve" },
                            style: "primary",
                            action_id: "approve_runbook",
                            value: JSON.stringify(runbook)
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "❌ Reject" },
                            style: "danger",
                            action_id: "reject_runbook"
                        }
                    ]
                }
            ]
        });

        console.log(`📨 Approval DM sent to engineer ${user}`);

    } catch (error) {
        console.log("Error generating runbook:", error);
    }
});

bolt.action("approve_runbook", async ({ ack, body, client }) => {
    await ack();

    const runbook = JSON.parse((body as any).actions[0].value);
    const approvedBy = body.user.id;
    const teamId = (body as any).team?.id;

    console.log("✅ Engineer approved runbook:", runbook.title);

    await RunbookModel.create({
        teamId,
        title: runbook.title,
        severity: runbook.severity,
        overview: runbook.overview,
        rootCause: runbook.rootCause,
        actionsTaken: runbook.actionsTaken,
        preventionSteps: runbook.preventionSteps,
        keyEvents: runbook.keyEvents,
        owner: runbook.owner,
        incidentStart: runbook.incidentStart,
        incidentEnd: runbook.incidentEnd,
        approvedBy: approvedBy,
    });

    console.log("💾 Runbook saved to MongoDB");

    await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Runbook *"${runbook.title}"* approved and saved successfully.`
    });
});

bolt.action("reject_runbook", async ({ ack, body, client }) => {
    await ack();

    console.log("Engineer rejected the runbook");

    await client.chat.postMessage({
        channel: body.user.id,
        text: `Runbook rejected and discarded.`
    });
});

bolt.command("/runbook", async ({ command, ack, client }) => {
    await ack();

    const fullText = command.text.trim();
    const userId = command.user_id;
    const teamId = command.team_id;
    const channelId = command.channel_id;

    console.log(`/runbook command received: "${fullText}" from ${userId}`);

    const parts = fullText.split(" ");
    const subcommand = parts[0]?.toLowerCase();
    const query = parts.slice(1).join(" ").trim();

    if (subcommand === "search") {

        if (!query) {
            await client.chat.postEphemeral({
                channel: channelId,
                user: userId,
                text: "Please provide a search term. Example: `/runbook search DB connection`"
            });
            return;
        }

        try {
            const results = await searchRunbooks(query, teamId);

            if (results.length === 0) {
                await client.chat.postEphemeral({
                    channel: channelId,
                    user: userId,
                    text: `🔍 No runbooks found for "*${query}*". Try a different search term.`
                });
                return;
            }

            const resultBlocks: any[] = [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `🔍 *Found ${results.length} runbook${results.length > 1 ? "s" : ""} for "${query}":*`
                    }
                },
                { type: "divider" }
            ];

            results.forEach((runbook, index) => {
                const severityEmoji = {
                    high: "🔴",
                    medium: "🟡",
                    low: "🟢"
                }[runbook.severity?.toLowerCase()] || "⚪";

                const date = runbook.createdAt
                    ? new Date(runbook.createdAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric"
                    })
                    : "Unknown date";

                resultBlocks.push({
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*${index + 1}. ${runbook.title}*`
                        },
                        {
                            type: "mrkdwn",
                            text: `${severityEmoji} ${runbook.severity?.toUpperCase() || "UNKNOWN"}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Root Cause:*\n${runbook.rootCause || "Not specified"}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Date:*\n${date}`
                        }
                    ]
                });

                resultBlocks.push({
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Overview:* ${runbook.overview || "No overview available"}`
                    }
                });

                if (runbook.preventionSteps?.length > 0) {
                    const steps = runbook.preventionSteps
                        .map((step, i) => `${i + 1}. ${step}`)
                        .join("\n");

                    resultBlocks.push({
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Prevention Steps:*\n${steps}`
                        }
                    });
                }

                if (index < results.length - 1) {
                    resultBlocks.push({ type: "divider" });
                }
            });

            await client.chat.postEphemeral({
                channel: channelId,
                user: userId,
                text: `Found ${results.length} runbooks for "${query}"`,
                blocks: resultBlocks
            });

            console.log(`✅ Sent ${results.length} search results to ${userId}`);

        } catch (error) {
            console.error("Search error:", error);
            await client.chat.postEphemeral({
                channel: channelId,
                user: userId,
                text: "❌ Search failed. Please try again."
            });
        }
        return;
    }

    if (subcommand === "github-link") {
        if (!query) {
            await client.chat.postEphemeral({
                channel: channelId,
                user: userId,
                text: "Please provide a GitHub org or owner name. Example: `/runbook github-link my-org`"
            });
            return;
        }

        const orgName = query.toLowerCase();

        try {
            const installation = await InstallationModel.findOne({ teamId });
            if (!installation) {
                await client.chat.postEphemeral({
                    channel: channelId,
                    user: userId,
                    text: "❌ No Slack installation found for this workspace. Please reinstall RunbookAI."
                });
                return;
            }

            const alreadyLinked = installation.githubOrgs.some((org: string) => org.toLowerCase() === orgName);

            if (alreadyLinked) {
                await client.chat.postEphemeral({
                    channel: channelId,
                    user: userId,
                    text: `ℹ️ GitHub org \`${orgName}\` is already linked to this workspace.`
                });
                return;
            }

            installation.githubOrgs.push(orgName);
            await installation.save();

            await client.chat.postEphemeral({
                channel: channelId,
                user: userId,
                text: `GitHub org \`${orgName}\` is now linked to this Slack workspace.\n\nHotfix PRs from \`${orgName}\` repos will generate runbooks here.`
            });

            console.log(`Linked GitHub org "${orgName}" to team ${teamId}`);

        } catch (error) {
            console.error("GitHub link error:", error);
            await client.chat.postEphemeral({
                channel: channelId,
                user: userId,
                text: "Failed to link GitHub org. Please try again."
            });
        }
        return;
    }

    await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "🤖 *RunbookAI Commands*",
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "🤖 *RunbookAI — Available Commands*"
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "`/runbook search [query]` — Search runbooks by keyword\n*Example:* `/runbook search DB connection`"
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "`/runbook github-link [org]` — Link a GitHub org to this workspace\n*Example:* `/runbook github-link my-org`"
                }
            }
        ]
    });
});

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

const start = async () => {
    await connectDB();
    await bolt.start(3001);
    console.log("Bolt is running on port 3001");

    app.listen(PORT, () => {
        console.log(`Express server running on port ${PORT}`);
    });
};

start();