import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

export type GeneratedPRRunbook = {
  title: string;
  severity: string;
  incidentStart?: string;
  incidentEnd?: string;
  overview: string;
  rootCause: string;
  actionsTaken: string[];
  preventionSteps: string[];
  keyEvents?: string[];
  affectedFiles?: string[];
  owner: string;
}

const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const githubModel = client.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING },
        severity: { type: SchemaType.STRING, description: "high | medium | low" },
        overview: { type: SchemaType.STRING },
        rootCause: { type: SchemaType.STRING },
        actionsTaken: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        preventionSteps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        keyEvents: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        affectedFiles: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        owner: { type: SchemaType.STRING }
      },
      required: ["title", "severity", "overview", "rootCause", "actionsTaken", "preventionSteps", "owner"]
    }
  }
});

const callWithRetry = async (model: ReturnType<typeof client.getGenerativeModel>, prompt: string, retries = 3, delay = 2000) => {
  try {
    return await model.generateContent(prompt);
  } catch (error: unknown) {
    const err = error as { status?: number };
    if ((err.status === 503 || err.status === 429) && retries > 0) {
      console.warn(`[WARNING] Gemini busy (Status ${err.status}). Retrying in ${delay / 1000}s... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return callWithRetry(model, prompt, retries - 1, delay * 2);
    }
    throw error;
  }
};

const generateRunbookFromPR = async (prData: {
  title: string;
  description: string;
  author: string;
  mergedBy: string;
  url: string;
  labels: string[];
  headBranch: string;
  repoName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}): Promise<GeneratedPRRunbook | null> => {
  const prompt = `You are an expert SRE and Incident Manager.
Analyze this GitHub Pull Request and generate a structured runbook document.

PR Title: ${prData.title}
PR Description: ${prData.description || "No description provided"}
Author: ${prData.author}
Branch: ${prData.headBranch}
Repository: ${prData.repoName}
Labels: ${prData.labels.join(", ") || "none"}
Changes: +${prData.additions} -${prData.deletions} across ${prData.changedFiles} files

Generate a runbook based on this PR information.
Infer the incident details from the PR title, description, and branch name.
Owner should be the PR author: ${prData.author}`;

  try {
    const result = await callWithRetry(githubModel, prompt);
    const rawText = result.response.text();
    const runbook: GeneratedPRRunbook = JSON.parse(rawText);
    return runbook;
  } catch (error) {
    console.error("Error generating runbook from PR:", error);
    return null;
  }
};

export { generateRunbookFromPR };
