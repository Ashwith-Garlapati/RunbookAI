import { WebClient } from "@slack/web-api";

const readFullThread = async (token: String, channelId: String) => {
    const client = new WebClient(token as string);

    const result = await client.conversations.history({
        channel: channelId as string,
        limit: 50
    });

    if (!result.messages) return [];

    const formatted = result.messages
        .reverse()
        .filter(msg => msg.text && msg.text.length > 0)
        .map(msg => {
            const user = msg.user || "unknown";
            const text = msg.text || "";

            return `${user}: ${text}`;
        });

    console.log(`Read ${formatted.length} messages from channel`);

    return formatted;
};

export { readFullThread };