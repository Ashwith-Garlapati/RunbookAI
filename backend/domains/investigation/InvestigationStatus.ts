/**
 * Investigation Domain - Status Lifecycle
 *
 * Defines the complete set of investigation states and enforces
 * valid state transitions. An investigation follows a strict lifecycle:
 *
 *   Draft → CollectingEvidence → Analyzing → GeneratingFindings
 *     → Resolved → GeneratingRunbook → WaitingApproval → Completed → Archived
 *
 * "Resolved" is a HUMAN action: an engineer marks the incident resolved.
 * Only after resolution does runbook generation begin. Resolve is a
 * terminal investigation state (the investigation is finished, but the
 * incident documentation continues).
 *
 * A resolved investigation can be REOPENED (Resolved → CollectingEvidence)
 * when the incident resurfaces - the investigation resumes evidence
 * collection instead of starting a duplicate.
 *
 * Invalid transitions throw an error. Use canTransition() to check validity.
 */

export enum InvestigationStatus {
  Draft = "draft",
  CollectingEvidence = "collecting_evidence",
  Analyzing = "analyzing",
  GeneratingFindings = "generating_findings",
  Resolved = "resolved",
  GeneratingRunbook = "generating_runbook",
  WaitingApproval = "waiting_approval",
  Completed = "completed",
  Archived = "archived",
}

const VALID_TRANSITIONS: Readonly<Record<InvestigationStatus, readonly InvestigationStatus[]>> = {
  [InvestigationStatus.Draft]: [
    InvestigationStatus.CollectingEvidence,
    InvestigationStatus.Resolved,
  ],
  [InvestigationStatus.CollectingEvidence]: [
    InvestigationStatus.Analyzing,
    InvestigationStatus.Resolved,
  ],
  [InvestigationStatus.Analyzing]: [
    InvestigationStatus.GeneratingFindings,
    InvestigationStatus.Resolved,
  ],
  [InvestigationStatus.GeneratingFindings]: [
    InvestigationStatus.GeneratingRunbook,
    InvestigationStatus.Resolved,
  ],
  [InvestigationStatus.Resolved]: [
    InvestigationStatus.CollectingEvidence,
    InvestigationStatus.GeneratingRunbook,
    InvestigationStatus.Completed,
  ],
  [InvestigationStatus.GeneratingRunbook]: [InvestigationStatus.WaitingApproval],
  [InvestigationStatus.WaitingApproval]: [InvestigationStatus.Completed],
  [InvestigationStatus.Completed]: [InvestigationStatus.Archived],
  [InvestigationStatus.Archived]: [],
};

/**
 * Returns true if the investigation is actively being worked on
 * (not completed or archived).
 */
export function isActive(status: InvestigationStatus): boolean {
  return status !== InvestigationStatus.Completed && status !== InvestigationStatus.Archived;
}

/**
 * Checks whether a transition from one status to another is valid
 * without throwing.
 */
export function canTransition(from: InvestigationStatus, to: InvestigationStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Validates that a transition is legal. Throws InvalidTransitionError if not.
 */
export function validateTransition(from: InvestigationStatus, to: InvestigationStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/**
 * Thrown when an invalid status transition is attempted on an Investigation.
 */
export class InvalidTransitionError extends Error {
  readonly from: InvestigationStatus;
  readonly to: InvestigationStatus;

  constructor(from: InvestigationStatus, to: InvestigationStatus) {
    super(`Invalid transition from "${from}" to "${to}"`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}
