import mongoose, { Schema, Document } from "mongoose";

export interface IRunbook extends Document {
    teamId: string;
    channelId: string;
    title: string;
    severity: string;
    overview: string;
    rootCause: string;
    actionsTaken: string[];
    preventionSteps: string[];
    keyEvents: string[];
    owner: string;
    incidentStart: string;
    incidentEnd: string;
    approvedBy: string;
    source?: string;
    createdAt: Date;
}

const RunbookSchema = new Schema<IRunbook>({
    teamId: { type: String },
    channelId: { type: String },
    title: { type: String, required: true },
    severity: { type: String },
    overview: { type: String },
    rootCause: { type: String },
    actionsTaken: [{ type: String }],
    preventionSteps: [{ type: String }],
    keyEvents: [{ type: String }],
    owner: { type: String },
    incidentStart: { type: String },
    incidentEnd: { type: String },
    approvedBy: { type: String },
    source: { type: String },
    createdAt: { type: Date, default: Date.now }
});

export const RunbookModel = mongoose.model<IRunbook>("Runbook", RunbookSchema);