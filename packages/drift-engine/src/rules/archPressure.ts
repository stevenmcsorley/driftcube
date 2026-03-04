import type { Pool } from "pg";
import type { AlertRaised, MetricPoint, MetricsWritten, Severity } from "@driftcube/shared";
import { assessPressureAnomaly } from "../anomaly.js";

function contributorMetrics(metrics: MetricPoint[], subjectId: string): Record<string, number> {
  const keys = [
    "pressure_change",
    "pressure_coupling",
    "pressure_semantic",
    "pressure_boundary",
    "pressure_entropy",
    "pressure_volatility",
    "pressure_index",
  ];

  return Object.fromEntries(
    metrics
      .filter((metric) => metric.scope === "module" && (metric.subjectId ?? "") === subjectId && keys.includes(metric.key))
      .map((metric) => [metric.key, Number(metric.value.toFixed(2))]),
  );
}

export async function detectArchitecturePressure(pool: Pool, event: MetricsWritten): Promise<AlertRaised[]> {
  const pressureMetrics = event.metrics.filter((metric) => metric.scope === "module" && metric.key === "pressure_index");
  const alerts: AlertRaised[] = [];

  for (const metric of pressureMetrics) {
    const moduleName = metric.subjectId ?? "";
    if (!moduleName) {
      continue;
    }

    const assessment = await assessPressureAnomaly(pool, {
      repoId: event.repoId,
      subjectId: moduleName,
      at: event.at,
      currentValue: metric.value,
    });
    const severity: Severity | null = assessment.severity;
    if (!severity) {
      continue;
    }

    const metrics = contributorMetrics(event.metrics, moduleName);
    metrics.previous_pressure_index = assessment.previousValue;
    metrics.pressure_baseline_24h = assessment.baseline24h;
    metrics.pressure_delta_24h = assessment.delta24h;
    metrics.pressure_baseline_mean = assessment.baselineMean;
    metrics.pressure_baseline_stddev = assessment.baselineStddev;
    metrics.pressure_z_score = assessment.zScore;
    metrics.pressure_warn_threshold = assessment.warnThreshold;
    metrics.pressure_error_threshold = assessment.errorThreshold;
    metrics.pressure_clear_threshold = assessment.clearThreshold;
    metrics.pressure_baseline_samples = assessment.sampleCount;

    alerts.push({
      schemaVersion: 1,
      repoId: event.repoId,
      commitSha: event.commitSha,
      at: new Date().toISOString(),
      severity,
      type: "ARCH_PRESSURE",
      title: `Architecture pressure building in ${moduleName}`,
      evidence: {
        module: moduleName,
        metrics,
      },
      recommendation: "Reduce boundary growth, split unstable responsibilities, or slow AI churn before the module hardens into an architecture hotspot.",
    });
  }

  return alerts;
}
