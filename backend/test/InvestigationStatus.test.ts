import { describe, it, expect } from "vitest";
import {
  InvestigationStatus,
  canTransition,
  validateTransition,
  isActive,
  InvalidTransitionError,
} from "../domains/investigation/InvestigationStatus.js";

describe("InvestigationStatus", () => {
  describe("canTransition", () => {
    it("allows valid transitions", () => {
      expect(canTransition(InvestigationStatus.Draft, InvestigationStatus.CollectingEvidence)).toBe(true);
      expect(canTransition(InvestigationStatus.CollectingEvidence, InvestigationStatus.Analyzing)).toBe(true);
      expect(canTransition(InvestigationStatus.Analyzing, InvestigationStatus.GeneratingFindings)).toBe(true);
      expect(canTransition(InvestigationStatus.GeneratingFindings, InvestigationStatus.GeneratingRunbook)).toBe(true);
      expect(canTransition(InvestigationStatus.GeneratingRunbook, InvestigationStatus.WaitingApproval)).toBe(true);
      expect(canTransition(InvestigationStatus.WaitingApproval, InvestigationStatus.Completed)).toBe(true);
      expect(canTransition(InvestigationStatus.Completed, InvestigationStatus.Archived)).toBe(true);
    });

    it("rejects invalid transitions", () => {
      expect(canTransition(InvestigationStatus.Draft, InvestigationStatus.Completed)).toBe(false);
      expect(canTransition(InvestigationStatus.Draft, InvestigationStatus.Analyzing)).toBe(false);
      expect(canTransition(InvestigationStatus.Completed, InvestigationStatus.Draft)).toBe(false);
      expect(canTransition(InvestigationStatus.Archived, InvestigationStatus.Draft)).toBe(false);
      expect(canTransition(InvestigationStatus.CollectingEvidence, InvestigationStatus.Completed)).toBe(false);
    });

    it("rejects self-transitions", () => {
      expect(canTransition(InvestigationStatus.Draft, InvestigationStatus.Draft)).toBe(false);
      expect(canTransition(InvestigationStatus.Completed, InvestigationStatus.Completed)).toBe(false);
    });
  });

  describe("validateTransition", () => {
    it("does not throw for valid transitions", () => {
      expect(() =>
        validateTransition(InvestigationStatus.Draft, InvestigationStatus.CollectingEvidence),
      ).not.toThrow();
    });

    it("throws InvalidTransitionError for invalid transitions", () => {
      expect(() =>
        validateTransition(InvestigationStatus.Draft, InvestigationStatus.Completed),
      ).toThrow(InvalidTransitionError);
    });
  });

  describe("isActive", () => {
    it("returns true for active statuses", () => {
      expect(isActive(InvestigationStatus.Draft)).toBe(true);
      expect(isActive(InvestigationStatus.CollectingEvidence)).toBe(true);
      expect(isActive(InvestigationStatus.Analyzing)).toBe(true);
      expect(isActive(InvestigationStatus.GeneratingFindings)).toBe(true);
      expect(isActive(InvestigationStatus.GeneratingRunbook)).toBe(true);
      expect(isActive(InvestigationStatus.WaitingApproval)).toBe(true);
    });

    it("returns false for terminal statuses", () => {
      expect(isActive(InvestigationStatus.Completed)).toBe(false);
      expect(isActive(InvestigationStatus.Archived)).toBe(false);
    });
  });

  describe("InvalidTransitionError", () => {
    it("contains from and to status", () => {
      const error = new InvalidTransitionError(
        InvestigationStatus.Draft,
        InvestigationStatus.Completed,
      );

      expect(error.from).toBe(InvestigationStatus.Draft);
      expect(error.to).toBe(InvestigationStatus.Completed);
      expect(error.name).toBe("InvalidTransitionError");
      expect(error.message).toContain("draft");
      expect(error.message).toContain("completed");
    });
  });
});
