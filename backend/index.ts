import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { WebClient } from "@slack/web-api";
import { App, type Installation } from "@slack/bolt";

import InstallationModel from "./models/Installation.model.js";
import { generateRunbook } from "./services/aiEngine.js";
import { detectionIncident } from "./services/aiEngine.js";
import { readFullThread } from "./services/slackReader.js";
import { RunbookModel } from "./models/Runbook.model.js";
import { searchRunbooks } from "./services/runbookSearch.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());


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
        console.log(`📌 ${detection.incidentType.toUpperCase()} incident in progress — monitoring...`);
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

            // Send results — ephemeral means only the user who typed the command sees it
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

    // ── /runbook (no subcommand) — show help
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
            }
        ]
    });
});

// app.post("/", async (req, res) => {
//     //connect to slack using their Events API✅

//     //connect to an ai llm model

//     //go through the conversation in the slack and check for incidents and only specific events

//     //Trigger the Logic --> checks for tags like fixed, resolved, root cause

// });

const start = async () => {
    await connectDB();
    await bolt.start(3001);
    console.log("Bolt is running on port 3001");

    app.listen(PORT, () => {
        console.log(`Express server running on port ${PORT}`);
    });
};

start();