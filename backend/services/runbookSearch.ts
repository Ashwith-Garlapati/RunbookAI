import { RunbookModel } from "../models/Runbook.model.js";

export const searchRunbooks = async (
    query: string,
    teamId: string,
    limit: number = 5
) => {
    console.log(`🔍 Searching runbooks for: "${query}"`);

    const results = await RunbookModel.find({
        teamId,
        $or: [
            { title: { $regex: query, $options: "i" } },
            { overview: { $regex: query, $options: "i" } },
            { rootCause: { $regex: query, $options: "i" } },
            { actionsTaken: { $regex: query, $options: "i" } },
            { keyEvents: { $regex: query, $options: "i" } },
        ]
    })
        .sort({ createdAt: -1 })
        .limit(limit);

    return results;
};