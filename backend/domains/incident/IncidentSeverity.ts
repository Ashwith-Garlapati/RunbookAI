/**
 * Incident Domain - Severity (always human/deterministic, never AI).
 *
 * Three levels: Critical > Major > Minor.
 */

export enum IncidentSeverity {
  Critical = "critical",
  Major = "major",
  Minor = "minor",
}

export const SEVERITY_LABELS: Readonly<Record<IncidentSeverity, string>> = {
  [IncidentSeverity.Critical]: "Critical",
  [IncidentSeverity.Major]: "Major",
  [IncidentSeverity.Minor]: "Minor",
};

export function parseSeverity(input: unknown): IncidentSeverity | undefined {
  if (typeof input !== "string") return undefined;
  const v = input.trim().toLowerCase();
  if (["critical", "crit", "sev1", "sev-1", "p1", "1"].includes(v)) return IncidentSeverity.Critical;
  if (["major", "sev2", "sev-2", "p2", "2"].includes(v)) return IncidentSeverity.Major;
  if (["minor", "low", "sev3", "sev-3", "sev4", "sev-4", "p3", "p4", "3", "4"].includes(v))
    return IncidentSeverity.Minor;
  return undefined;
}

export function severityLabel(severity: IncidentSeverity): string {
  return SEVERITY_LABELS[severity] ?? severity;
}
