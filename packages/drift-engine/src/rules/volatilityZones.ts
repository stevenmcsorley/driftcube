import type { Pool } from "pg";
import type { AlertRaised, MetricsWritten } from "@driftcube/shared";

export async function detectVolatilityZones(pool: Pool, event: MetricsWritten): Promise<AlertRaised[]> {
  const fileSubjects = new Set(
    event.metrics
      .map((metric) => metric.tags?.filePath)
      .filter((value): value is string => Boolean(value)),
  );

  const alerts: AlertRaised[] = [];

  for (const filePath of fileSubjects) {
    const result = await pool.query<{ shas: string[] }>(
      `
        SELECT ARRAY_AGG(DISTINCT sha) AS shas
        FROM metrics
        WHERE repo_id = $1
          AND at >= NOW() - INTERVAL '24 hours'
          AND tags ->> 'filePath' = $2
      `,
      [event.repoId, filePath],
    );

    const churn = result.rows[0]?.shas.length ?? 0;
    if (churn > 8) {
      alerts.push({
        schemaVersion: 1,
        repoId: event.repoId,
        commitSha: event.commitSha,
        at: new Date().toISOString(),
        severity: "warn",
        type: "VOLATILITY_ZONE",
        title: `High change volatility detected for ${filePath}`,
        evidence: {
          filePath,
          metrics: {
            churn,
          },
        },
        recommendation: "Stabilize this file with tests or split the surface area before more AI edits land.",
      });
    }
  }

  return alerts;
}

