/**
 * Investigation Domain - Timeline Event Type Enum
 *
 * Categorizes entries in an investigation's chronological timeline.
 * The TimelineService records entries of these types automatically.
 */

export enum TimelineEventType {
  InvestigationCreated = "investigation_created",
  StatusChanged = "status_changed",
  EvidenceAdded = "evidence_added",
  FindingAdded = "finding_added",
  RunbookGenerated = "runbook_generated",
  ReportGenerated = "report_generated",
  Completed = "completed",
  Archived = "archived",
}
