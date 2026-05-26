import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const model = client.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: "short incident title, 4-5 words max" },
        severity: { type: SchemaType.STRING, description: "high | medium | low" },
        incidentStart: { type: SchemaType.STRING, description: "YYYY-MM-DD HH:MM:SS" },
        incidentEnd: { type: SchemaType.STRING, description: "YYYY-MM-DD HH:MM:SS" },
        overview: { type: SchemaType.STRING, description: "2-3 sentence summary of what happened" },
        keyEvents: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        rootCause: { type: SchemaType.STRING },
        actionsTaken: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        preventionSteps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        owner: { type: SchemaType.STRING, description: "who resolved it" }
      },
      required: ["title", "severity", "overview", "rootCause", "actionsTaken", "preventionSteps", "owner"]
    }
  }
});

const callWithRetry = async (prompt: string, retries = 3, delay = 2000): Promise<any> => {
  try {
    return await model.generateContent(prompt);
  } catch (error: any) {
    if ((error.status === 503 || error.status === 429) && retries > 0) {
      console.warn(`[WARNING] Gemini busy (Status ${error.status}). Retrying in ${delay / 1000}s... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return callWithRetry(prompt, retries - 1, delay * 2);
    }
    throw error;
  }
};

const generateRunbook = async (messages: string[], channelName: string) => {
  console.log("Gemini Key loaded:", process.env.GEMINI_API_KEY ? "YES ✅" : "NO ❌");

  const conversation = messages.join("\n");
  const prompt = `You are an expert SRE and Incident Manager.
    Analyze this Slack conversation from channel "${channelName}" and extract the incident runbook data.

    Conversation:
    ${conversation}
    
    Return ONLY valid JSON — no markdown, no extra text, no backticks`;

  try {
    const result = await callWithRetry(prompt);
    const rawText = result.response.text();
    const runbook = JSON.parse(rawText);
    return runbook;

  } catch (error) {
    console.error("Error generating runbook after retries:", error);
    return null;
  }
}

export { generateRunbook };
