import { describe, it, expect } from "vitest";
import { MentionIntentDetector, MentionIntent } from "../services/MentionIntentDetector.js";

describe("MentionIntentDetector", () => {
  const detector = new MentionIntentDetector();

  describe("help intent", () => {
    it.each(["help", "Help", "what can you do?", "how do I use this", "show me the commands"])(
      "detects %j as help",
      (text) => {
        expect(detector.detect(text).intent).toBe(MentionIntent.Help);
      },
    );
  });

  describe("resolve intent", () => {
    it.each([
      "resolve this investigation",
      "mark this as resolved",
      "close this incident",
      "investigation resolved",
      "incident resolved",
      "mark this resolved",
    ])("detects %j as resolve", (text) => {
      expect(detector.detect(text).intent).toBe(MentionIntent.Resolve);
    });
  });

  describe("investigate intent", () => {
    it.each([
      "investigate this",
      "investigate checkout API failures",
      "start investigation",
      "start an investigation",
      "create an investigation",
      "open an incident investigation",
    ])("detects %j as investigate", (text) => {
      expect(detector.detect(text).intent).toBe(MentionIntent.Investigate);
    });
  });

  describe("question intent", () => {
    it.each([
      "summarize this thread",
      "what caused this?",
      "what changed today?",
      "explain this error",
      "who deployed this?",
      "what should we check next",
      "is the checkout API still down?",
    ])("detects %j as question", (text) => {
      expect(detector.detect(text).intent).toBe(MentionIntent.Question);
    });
  });

  describe("unknown intent", () => {
    it("returns unknown for empty text", () => {
      expect(detector.detect("").intent).toBe(MentionIntent.Unknown);
    });

    it("returns unknown for whitespace", () => {
      expect(detector.detect("   ").intent).toBe(MentionIntent.Unknown);
    });

    it("returns unknown for punctuation-only text", () => {
      expect(detector.detect("!!?").intent).toBe(MentionIntent.Unknown);
    });
  });

  describe("priority rules", () => {
    it("treats 'investigation resolved' as resolve, not investigate", () => {
      expect(detector.detect("investigation resolved").intent).toBe(MentionIntent.Resolve);
    });

    it("treats 'help' inside a question as help", () => {
      expect(detector.detect("can you help me understand this?").intent).toBe(MentionIntent.Help);
    });
  });
});
