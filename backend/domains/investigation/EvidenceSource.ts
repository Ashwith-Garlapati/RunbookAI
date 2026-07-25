/**
 * Investigation Domain - Evidence Source Enum
 *
 * Identifies which external system provided a piece of evidence.
 * Used to trace evidence back to its origin for verification.
 */

export enum EvidenceSource {
  Slack = "slack",
  GitHub = "github",
  SigNoz = "signoz",
  Datadog = "datadog",
  Grafana = "grafana",
  Prometheus = "prometheus",
  PagerDuty = "pagerduty",
  CloudWatch = "cloudwatch",
  Kubernetes = "kubernetes",
  API = "api",
  Manual = "manual",
}
