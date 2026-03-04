import type { Pool } from "pg";
import type { AlertRaised, MetricsWritten, MetricPoint, Severity } from "@driftcube/shared";
import { assessEntropyAnomaly } from "../anomaly.js";

function metricScopeLabel(scope: MetricPoint["scope"]): string {
  return scope === "repo" ? "Repo" : "Module";
}

function contributorMetrics(metrics: MetricPoint[], scope: MetricPoint["scope"], subjectId: string): Record<string, number> {
  const keys = [
    "dependency_entropy",
    "duplication_entropy",
    "complexity_entropy",
    "change_entropy",
    "architecture_entropy",
    "code_entropy_index",
  ];

  return Object.fromEntries(
    metrics
      .filter((metric) => metric.scope === scope && (metric.subjectId ?? "") === subjectId && keys.includes(metric.key))
      .map((metric) => [metric.key, Number(metric.value.toFixed(2))]),
  );
}

export async function detectEntropyDrift(pool: Pool, event: MetricsWritten): Promise<AlertRaised[]> {
  const entropyMetrics = event.metrics.filter((metric) =>
    (metric.scope === "repo" || metric.scope === "module") && metric.key === "code_entropy_index");

  const alerts: AlertRaised[] = [];

  for (const metric of entropyMetrics) {
    const subjectId = metric.subjectId ?? event.repoId;
    const scope = metric.scope === "module" ? "module" : "repo";
    const assessment = await assessEntropyAnomaly(pool, {
      repoId: event.repoId,
      scope,
      subjectId,
      at: event.at,
      currentValue: metric.value,
    });
    const severity: Severity | null = assessment.severity;
    if (!severity) {
      continue;
    }

    const metrics = contributorMetrics(event.metrics, scope, subjectId);
    metrics.previous_entropy_index = assessment.previousValue;
    metrics.entropy_delta = assessment.delta;
    metrics.entropy_baseline_mean = assessment.baselineMean;
    metrics.entropy_baseline_stddev = assessment.baselineStddev;
    metrics.entropy_z_score = assessment.zScore;
    metrics.entropy_warn_threshold = assessment.warnThreshold;
    metrics.entropy_error_threshold = assessment.errorThreshold;
    metrics.entropy_clear_threshold = assessment.clearThreshold;
    metrics.entropy_baseline_samples = assessment.sampleCount;

    alerts.push({
      schemaVersion: 1,
      repoId: event.repoId,
      commitSha: event.commitSha,
      at: new Date().toISOString(),
      severity,
      type: "ENTROPY_DRIFT",
      title: `${metricScopeLabel(metric.scope)} entropy rising in ${subjectId}`,
      evidence: {
        module: scope === "module" ? subjectId : undefined,
        metrics,
      },
      recommendation: "Reduce dependency spread, duplication, and churn before this surface hardens into chaotic structure.",
    });
  }

  return alerts;
}
