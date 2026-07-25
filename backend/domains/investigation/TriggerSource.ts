/**
 * Investigation Domain - Trigger Source Enum
 *
 * Identifies the external system or interface that initiated an investigation.
 * Every integration point creates a Trigger with one of these sources.
 */

export enum TriggerSource {
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
  Future = "future",
}
