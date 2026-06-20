import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

export const verifyGitHubSignature = (
    payload: string,
    signature: string
): boolean => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET || "";
    if (!secret) {
        console.error("GITHUB_WEBHOOK_SECRET is not configured");
        return false;
    }
    const hmac = crypto.createHmac("sha256", secret);
    const digest = "sha256=" + hmac.update(payload).digest("hex");
    const digestBuf = Buffer.from(digest);
    const signatureBuf = Buffer.from(signature);
    if (digestBuf.length !== signatureBuf.length) {
        return false;
    }
    return crypto.timingSafeEqual(digestBuf, signatureBuf);
};

export const extractPRData = (payload: any) => {
    const pr = payload.pull_request;
    if (!pr) {
        throw new Error("payload.pull_request is required");
    }

    return {
        title: pr.title || "",
        description: pr.body || "",
        author: pr.user?.login || "",
        authorId: pr.user?.id || "",
        mergedBy: payload.sender?.login || "",
        url: pr.html_url || "",
        labels: pr.labels?.map((l: any) => l.name) || [],
        baseBranch: pr.base?.ref || "",
        headBranch: pr.head?.ref || "",
        repoName: payload.repository?.name || "",
        repoOwner: payload.repository?.owner?.login || "",
        mergedAt: pr.merged_at || "",
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changedFiles: pr.changed_files || 0
    };
};

export const isHotfixPR = (prData: ReturnType<typeof extractPRData>): boolean => {
    const hotfixLabels = ["hotfix", "bugfix", "incident", "fix", "urgent", "critical"];
    const hotfixBranchPatterns = ["hotfix/", "fix/", "bugfix/", "incident/"];
    const hotfixTitlePatterns = ["fix:", "hotfix:", "bugfix:", "[fix]", "[hotfix]", "revert:"];
    const hasHotfixLabel = prData.labels.some((label: string) =>
        hotfixLabels.includes(label.toLowerCase())
    );
    const hasHotfixBranch = hotfixBranchPatterns.some(pattern =>
        prData.headBranch.toLowerCase().startsWith(pattern)
    );
    const hasHotfixTitle = hotfixTitlePatterns.some(pattern =>
        prData.title.toLowerCase().startsWith(pattern)
    );

    return hasHotfixLabel || hasHotfixBranch || hasHotfixTitle;
};