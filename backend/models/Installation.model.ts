import mongoose, { Schema, Document } from "mongoose";

export interface IInstallation extends Document {
    teamId: string;
    teamName: string;
    botToken: string;
    botUserId: string;
    botId?: string;
    defaultCommanderId?: string;
    /** Legacy name for defaultCommanderId — still read, no longer written. */
    defaultLeadId?: string;
    githubOrgs: string[];
    installedAt: Date;
}

const installationSchema = new Schema<IInstallation>({
    teamId: {
        type: String,
        required: true,
        unique: true
    },
    teamName: {
        type: String,
    },
    botToken: {
        type: String,
        required: true
    },
    botUserId: {
        type: String,
    },
    botId: {
        type: String,
    },
    defaultCommanderId: {
        type: String,
    },
    defaultLeadId: {
        type: String,
    },
    githubOrgs: {
        type: [String],
        default: []
    },
    installedAt: {
        type: Date,
        default: Date.now
    }
});

const InstallationModel = mongoose.model<IInstallation>("Installation", installationSchema);

export default InstallationModel;