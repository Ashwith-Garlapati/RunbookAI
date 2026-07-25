import mongoose, { Schema, Document } from "mongoose";

export interface IIncidentSession extends Document {
    channelId: string;
    teamId: string;
    sessionName: string;
    status: "active" | "resolved";
    triggeredBy: string;
    severity: string,
    affectedService: string,
    incidentType: string,
    startedAt: Date;
    resolvedBy?: string;
    resolvedAt?: Date;
    messages: string[];
}

const IncidentSessionSchema = new Schema<IIncidentSession>({
    channelId: { type: String, required: true },
    teamId: { type: String, required: true },
    sessionName: { type: String, required: true },
    status: {
        type: String,
        enum: ["active", "resolved"],
        default: "active"
    },
    triggeredBy: { type: String, required: true },
    severity: { type: String },          // ← from modal
    affectedService: { type: String },   // ← from modal
    incidentType: { type: String },      // ← from modal
    startedAt: { type: Date, default: Date.now },
    resolvedBy: { type: String },
    resolvedAt: { type: Date },
    messages: [{ type: String }]
});

// Only one active session per channel per team
IncidentSessionSchema.index(
    { channelId: 1, teamId: 1, status: 1 },
    {
        unique: true,
        partialFilterExpression: { status: "active" }
    }
);

export const IncidentSessionModel = mongoose.model<IIncidentSession>(
    "IncidentSession",
    IncidentSessionSchema
);