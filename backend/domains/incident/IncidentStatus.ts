/**
 * Incident Domain - Status Lifecycle (deterministic, human-driven).
 *
 * DETECTED -> INVESTIGATING | CANCELLED
 * INVESTIGATING -> IDENTIFIED | MITIGATING | RESOLVED | CANCELLED
 * IDENTIFIED -> MITIGATING | RESOLVED
 * MITIGATING -> MONITORING | RESOLVED
 * MONITORING -> MITIGATING | RESOLVED
 * RESOLVED -> CLOSED
 * CANCELLED -> CLOSED
 *
 * Resolution means "the operational incident has stopped".
 * Closing means "the incident workflow is complete".
 * Cancellation preserves history — incidents are never deleted.
 */

export enum IncidentStatus {
  Detected = "detected",
  Investigating = "investigating",
  Identified = "identified",
  Mitigating = "mitigating",
  Monitoring = "monitoring",
  Resolved = "resolved",
  Closed = "closed",
  Cancelled = "cancelled",
}

const VALID_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  [IncidentStatus.Detected]: [IncidentStatus.Investigating, IncidentStatus.Cancelled],
  [IncidentStatus.Investigating]: [
    IncidentStatus.Identified,
    IncidentStatus.Mitigating,
    IncidentStatus.Resolved,
    IncidentStatus.Cancelled,
  ],
  [IncidentStatus.Identified]: [IncidentStatus.Mitigating, IncidentStatus.Resolved],
  [IncidentStatus.Mitigating]: [IncidentStatus.Monitoring, IncidentStatus.Resolved],
  [IncidentStatus.Monitoring]: [IncidentStatus.Mitigating, IncidentStatus.Resolved],
  [IncidentStatus.Resolved]: [IncidentStatus.Closed],
  [IncidentStatus.Cancelled]: [IncidentStatus.Closed],
  [IncidentStatus.Closed]: [],
};

export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Human label for UI. Mitigating is shown as "Fixing". */
export function incidentStatusLabel(status: IncidentStatus): string {
  if (status === IncidentStatus.Mitigating) return "Fixing";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export class InvalidIncidentTransitionError extends Error {
  readonly from: IncidentStatus;
  readonly to: IncidentStatus;

  constructor(from: IncidentStatus, to: IncidentStatus) {
    super(`Invalid incident transition from "${from}" to "${to}"`);
    this.name = "InvalidIncidentTransitionError";
    this.from = from;
    this.to = to;
  }
}
