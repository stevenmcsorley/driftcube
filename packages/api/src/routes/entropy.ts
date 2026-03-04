import { z } from "zod";
import type { FastifyInstance } from "fastify";

function entropyPosture(value: number): "stable" | "normal" | "drifting" | "unstable" | "chaotic" {
  if (value >= 80) return "chaotic";
  if (value >= 60) return "unstable";
  if (value >= 40) return "drifting";
  if (value >= 20) return "normal";
  return "stable";
}

export async function registerEntropyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/entropy", async (request) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);

    const current = await app.db.query(
      `
        WITH latest AS (
          SELECT DISTINCT ON (key)
            key,
            value,
            at
          FROM metrics
          WHERE repo_id = $1
            AND scope = 'repo'
            AND key = ANY($2::text[])
          ORDER BY key, at DESC
        )
        SELECT key, value, at
        FROM latest
      `,
      [params.repoId, [
        "code_entropy_index",
        "dependency_entropy",
        "duplication_entropy",
        "complexity_entropy",
        "change_entropy",
        "architecture_entropy",
      ]],
    );

    const trend = await app.db.query(
      `
        SELECT
          time_bucket('15 minutes', at) AS bucket,
          ROUND(AVG(value)::numeric, 2) AS entropy_index
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'repo'
          AND key = 'code_entropy_index'
        GROUP BY bucket
        ORDER BY bucket DESC
        LIMIT 16
      `,
      [params.repoId],
    );

    const modules = await app.db.query(
      `
        WITH latest_entropy AS (
          SELECT DISTINCT ON (subject_id)
            subject_id,
            value,
            at
          FROM metrics
          WHERE repo_id = $1
            AND scope = 'module'
            AND key = 'code_entropy_index'
          ORDER BY subject_id, at DESC
        ),
        latest_ai AS (
          SELECT DISTINCT ON (subject_id)
            subject_id,
            value,
            at
          FROM metrics
          WHERE repo_id = $1
            AND scope = 'module'
            AND key = 'ai_risk_score'
          ORDER BY subject_id, at DESC
        )
        SELECT
          e.subject_id AS "moduleId",
          ROUND(e.value::numeric, 2) AS "entropyIndex",
          ROUND(COALESCE(a.value, 0)::numeric, 2) AS "aiRisk",
          GREATEST(e.at, COALESCE(a.at, e.at)) AS "lastSeen"
        FROM latest_entropy e
        LEFT JOIN latest_ai a
          ON a.subject_id = e.subject_id
        ORDER BY e.value DESC, e.subject_id ASC
        LIMIT 10
      `,
      [params.repoId],
    );

    const metrics = Object.fromEntries(
      current.rows.map((row) => [String(row.key), Number(row.value ?? 0)]),
    ) as Record<string, number>;

    const entropyIndex = Number(metrics.code_entropy_index ?? 0);

    return {
      repoId: params.repoId,
      current: {
        entropyIndex,
        posture: entropyPosture(entropyIndex),
      },
      contributors: {
        dependency: Number(metrics.dependency_entropy ?? 0),
        duplication: Number(metrics.duplication_entropy ?? 0),
        complexity: Number(metrics.complexity_entropy ?? 0),
        change: Number(metrics.change_entropy ?? 0),
        architecture: Number(metrics.architecture_entropy ?? 0),
      },
      trend: trend.rows
        .map((row) => ({
          at: row.bucket instanceof Date ? row.bucket.toISOString() : new Date(String(row.bucket)).toISOString(),
          entropyIndex: Number(row.entropy_index ?? 0),
        }))
        .reverse(),
      modules: modules.rows.map((row) => ({
        moduleId: String(row.moduleId ?? "unknown"),
        entropyIndex: Number(row.entropyIndex ?? 0),
        aiRisk: Number(row.aiRisk ?? 0),
        lastSeen: row.lastSeen instanceof Date
          ? row.lastSeen.toISOString()
          : new Date(String(row.lastSeen)).toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    };
  });
}
