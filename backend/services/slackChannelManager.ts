import { WebClient } from "@slack/web-api";

export const createIncidentChannel = async (
    token: string,
    incidentTitle: string,
    inviteUserId: string
): Promise<string | null> => {
    const client = new WebClient(token);

    const channelName = "incident-" + incidentTitle
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 40);

    try {
        const createResult = await client.conversations.create({
            name: channelName,
            is_private: false
        });

        const newChannelId = createResult.channel?.id;
        if (!newChannelId) {
            console.error("Failed to get channel ID after creation");
            return null;
        }

        await client.conversations.invite({
            channel: newChannelId,
            users: inviteUserId
        });
        await client.chat.postMessage({
            channel: newChannelId,
            text: `🚨 *Incident channel created by RunbookAI*\n\nThis channel is dedicated to tracking the current incident.\n\nType \`/runbook resolve\` when the incident is fixed to generate a runbook.`
        });

        console.log(`✅ Created incident channel: #${channelName}`);
        return newChannelId;

    } catch (error: any) {
        // Channel name might already exist — add timestamp to make unique
        if (error.data?.error === "name_taken") {
            const timestamp = Date.now().toString().slice(-4);
            const uniqueName = `${channelName}-${timestamp}`;

            const retryResult = await client.conversations.create({
                name: uniqueName,
                is_private: false
            });

            return retryResult.channel?.id || null;
        }

        console.error("Error creating channel:", error);
        return null;
    }
};