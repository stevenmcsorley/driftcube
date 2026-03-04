import type { AlertRaised, MetricsWritten } from "@driftcube/shared";

export function detectComplexityCreep(event: MetricsWritten): AlertRaised[] {
  const alerts: AlertRaised[] = [];
  const bySubject = new Map<string, Record<string, number>>();

  for (const metric of event.metrics) {
    if (metric.scope !== "symbol" || !metric.subjectId) {
      continue;
    }

    const existing = bySubject.get(metric.subjectId) ?? {};
    existing[metric.key] = metric.value;
    bySubject.set(metric.subjectId, existing);
  }

  for (const [subjectId, metrics] of bySubject.entries()) {
    const cyclomatic = metrics.cyclomatic ?? 0;
    const lineCount = metrics.line_count ?? 0;
    const aiRisk = metrics.ai_risk_score ?? 0;

    if (cyclomatic < 15 && aiRisk < 50 && lineCount < 120) {
      continue;
    }

    alerts.push({
      schemaVersion: 1,
      repoId: event.repoId,
      commitSha: event.commitSha,
      at: new Date().toISOString(),
      severity: cyclomatic >= 25 || aiRisk >= 75 ? "error" : "warn",
      type: "COMPLEXITY_CREEP",
      title: `Complexity threshold exceeded for ${subjectId}`,
      evidence: {
        symbolId: subjectId,
        metrics: {
          cyclomatic,
          lineCount,
          aiRisk,
        },
      },
      recommendation: "Refactor branching, split responsibilities, or add guardrails before the component drifts further.",
    });
  }

  return alerts;
}

