import type { Pool } from "pg";
import type { MetricPoint, MetricsWritten } from "@driftcube/shared";

export async function insertMetrics(pool: Pool, payload: MetricsWritten): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    for (const metric of payload.metrics) {
      await client.query(
        `
          INSERT INTO metrics (repo_id, sha, at, scope, subject_id, key, value, tags)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          ON CONFLICT (repo_id, sha, at, scope, subject_id, key)
          DO UPDATE SET value = EXCLUDED.value, tags = EXCLUDED.tags
        `,
        [
          payload.repoId,
          payload.commitSha,
          payload.at,
          metric.scope,
          metric.subjectId ?? "",
          metric.key,
          metric.value,
          JSON.stringify(metric.tags ?? {}),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function buildMetric(scope: MetricPoint["scope"], key: string, value: number, subjectId?: string, tags?: Record<string, string>): MetricPoint {
  return { scope, key, value, subjectId, tags };
}

