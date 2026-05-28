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

const incidentDetectionModel = client.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        isIncident: {
          type: SchemaType.BOOLEAN,
          description: "true if this message is about a technical incident"
        },
        isResolved: {
          type: SchemaType.BOOLEAN,
          description: "true if the incident is being marked as resolved"
        },
        incidentType: {
          type: SchemaType.STRING,
          description: "database | server | api | security | data | external | unknown"
        },
        confidence: {
          type: SchemaType.NUMBER,
          description: "confidence score between 0 and 1"
        },
        reason: {
          type: SchemaType.STRING,
          description: "one sentence explaining why this is or is not an incident"
        }
      },
      required: ["isIncident", "isResolved", "incidentType", "confidence", "reason"]
    }
  }
});

const callWithRetry = async (model: any, prompt: string, retries = 3, delay = 2000): Promise<any> => {
  try {
    return await model.generateContent(prompt);
  } catch (error: any) {
    if ((error.status === 503 || error.status === 429) && retries > 0) {
      console.warn(`[WARNING] Gemini busy (Status ${error.status}). Retrying in ${delay / 1000}s... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return callWithRetry(model, prompt, retries - 1, delay * 2);
    }
    throw error;
  }
};

const technicalWords = [
  'error', 'down', 'fail', 'spike', 'crash', 'broken',
  'slow', 'timeout', 'issue', 'problem', 'not working',
  'outage', 'alert', 'incident', 'resolved', 'fixed',
  'restored', 'investigating', 'memory', 'cpu', 'disk',
  '500', '502', '503', '504', 'latency', 'database'
];

const looksTechnical = (text: string): boolean => {
  return technicalWords.some(word =>
    text.toLowerCase().includes(word)
  );
};

const detectionIncident = async (message: string) => {
  if (!looksTechnical(message)) {
    return {
      isIncident: false,
      isResolved: false,
      incidentType: "unknown",
      confidence: 0,
      reason: "Message does not look like an incident"
    };
  }


  const prompt = `You are an expert SRE monitoring Slack messages.
      Analyze this single Slack message and determine:
      1. Is this message reporting, discussing, or resolving a technical incident?
      2. Is the incident being marked as resolved in this message?
      3. What type of incident is it?

      Be strict — ignore casual conversation, jokes, questions, and non-technical messages.
      Only flag real technical problems affecting production systems.

      Message: "${message}"`;

  try {
    const result = await callWithRetry(incidentDetectionModel, prompt);
    const rawText = result.response.text();
    return JSON.parse(rawText);
  } catch (error) {
    console.error("Error detecting incident after retries:", error);
    return {
      isIncident: false,
      isResolved: false,
      incidentType: "unknown",
      confidence: 0,
      reason: "Detection failed"
    };
  }
}

const generateRunbook = async (messages: string[], channelName: string) => {
  console.log("Gemini Key loaded:", process.env.GEMINI_API_KEY ? "YES ✅" : "NO ❌");

  const conversation = messages.join("\n");
  const prompt = `You are an expert SRE and Incident Manager.
    Analyze this Slack conversation from channel "${channelName}" and extract the incident runbook data.

    Conversation:
    ${conversation}
    
    Return ONLY valid JSON — no markdown, no extra text, no backticks`;

  try {
    const result = await callWithRetry(model, prompt);
    const rawText = result.response.text();
    const runbook = JSON.parse(rawText);
    return runbook;

  } catch (error) {
    console.error("Error generating runbook after retries:", error);
    return null;
  }
}

export { generateRunbook, detectionIncident };
