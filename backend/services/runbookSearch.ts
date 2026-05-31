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

export const findSimilarRunbooks = async (
    incidentMessage: string,
    incidentType: string,
    teamId: string,
    limit: number = 3
) => {
    console.log(`🔎 Finding similar past incidents for type: ${incidentType}`);

    const keywords = incidentMessage
        .toLowerCase()
        .split(" ")
        .filter(word => word.length > 3)
        .filter(word => !["this", "that", "with", "from", "have", "been", "they", "will"].includes(word));

    const keywordConditions = keywords.map(keyword => ({
        $or: [
            { title: { $regex: keyword, $options: "i" } },
            { overview: { $regex: keyword, $options: "i" } },
            { rootCause: { $regex: keyword, $options: "i" } },
            { keyEvents: { $regex: keyword, $options: "i" } },
        ]
    }));

    const results = await RunbookModel.find({
        teamId,
        $or: [
            { title: { $regex: incidentType, $options: "i" } },
            ...(keywordConditions.length > 0 ? keywordConditions : [])
        ]
    })
        .sort({ createdAt: -1 })
        .limit(limit);

    console.log(`Found ${results.length} similar past runbooks`);
    return results;
};