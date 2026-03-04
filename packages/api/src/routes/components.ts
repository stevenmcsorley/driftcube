import { z } from "zod";
import type { FastifyInstance } from "fastify";

export async function registerComponentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/components", async (request) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const result = await app.db.query(
      `
        WITH latest_symbol AS (
          SELECT DISTINCT ON (subject_id, key)
            subject_id,
            key,
            value,
            tags,
            at
          FROM metrics
          WHERE repo_id = $1
            AND scope = 'symbol'
          ORDER BY subject_id, key, at DESC
        ),
        latest_module AS (
          SELECT DISTINCT ON (subject_id, key)
            subject_id,
            key,
            value,
            at
          FROM metrics
          WHERE repo_id = $1
            AND scope = 'module'
          ORDER BY subject_id, key, at DESC
        )
        SELECT
          COALESCE(s.tags ->> 'module', 'root') AS id,
          COALESCE(s.tags ->> 'module', 'root') AS name,
          ROUND(AVG(CASE WHEN s.key = 'cyclomatic' THEN s.value END)::numeric, 2) AS avg_cyclomatic,
          ROUND(AVG(CASE WHEN s.key = 'ai_risk_score' THEN s.value END)::numeric, 2) AS avg_ai_risk,
          ROUND(MAX(CASE WHEN m.key = 'code_entropy_index' THEN m.value END)::numeric, 2) AS entropy_index,
          ROUND(MAX(CASE WHEN m.key = 'pressure_index' THEN m.value END)::numeric, 2) AS pressure_index,
          GREATEST(MAX(s.at), MAX(m.at)) AS last_seen
        FROM latest_symbol s
        LEFT JOIN latest_module m
          ON m.subject_id = COALESCE(s.tags ->> 'module', 'root')
        GROUP BY 1, 2
        ORDER BY last_seen DESC NULLS LAST
      `,
      [params.repoId],
    );

    return result.rows;
  });

  app.get("/repos/:repoId/components/:componentId", async (request) => {
    const params = z.object({ repoId: z.string(), componentId: z.string() }).parse(request.params);

    const summary = await app.db.query(
      `
        SELECT
          ROUND(AVG(CASE WHEN key = 'cyclomatic' THEN value END)::numeric, 2) AS avg_cyclomatic,
          ROUND(AVG(CASE WHEN key = 'ai_risk_score' THEN value END)::numeric, 2) AS avg_ai_risk,
          ROUND(AVG(CASE WHEN key = 'nesting_depth' THEN value END)::numeric, 2) AS avg_nesting,
          (
            SELECT ROUND(value::numeric, 2)
            FROM metrics module_metrics
            WHERE module_metrics.repo_id = $1
              AND module_metrics.scope = 'module'
              AND module_metrics.subject_id = $2
              AND module_metrics.key = 'code_entropy_index'
            ORDER BY module_metrics.at DESC
            LIMIT 1
          ) AS entropy_index,
          (
            SELECT ROUND(value::numeric, 2)
            FROM metrics module_metrics
            WHERE module_metrics.repo_id = $1
              AND module_metrics.scope = 'module'
              AND module_metrics.subject_id = $2
              AND module_metrics.key = 'pressure_index'
            ORDER BY module_metrics.at DESC
            LIMIT 1
          ) AS pressure_index
        FROM metrics
        WHERE repo_id = $1
          AND tags ->> 'module' = $2
      `,
      [params.repoId, params.componentId],
    );

    const metrics = await app.db.query(
      `
        SELECT at, scope, subject_id AS "subjectId", key, value, tags
        FROM metrics
        WHERE repo_id = $1
          AND tags ->> 'module' = $2
        ORDER BY at DESC
        LIMIT 100
      `,
      [params.repoId, params.componentId],
    );

    const alerts = await app.db.query(
      `
        SELECT
          md5(CONCAT_WS('|', repo_id, COALESCE(sha, ''), at::text, type, title)) AS id,
          at,
          severity,
          type,
          title,
          evidence,
          recommendation,
          sha
        FROM alerts
        WHERE repo_id = $1
          AND (
            evidence ->> 'module' = $2
            OR evidence ->> 'filePath' LIKE $3
          )
        ORDER BY at DESC
        LIMIT 50
      `,
      [params.repoId, params.componentId, `${params.componentId}%`],
    );

    const activity = await app.db.query(
      `
        SELECT
          event_id AS "eventId",
          repo_id AS "repoId",
          commit_sha AS "commitSha",
          at,
          file_path AS "filePath",
          absolute_path AS "absolutePath",
          language,
          change_type AS "changeType",
          parser_status AS "parserStatus",
          symbol_count AS "symbolCount",
          alert_count AS "alertCount",
          provenance,
          telemetry_source AS "telemetrySource",
          telemetry_editor AS "telemetryEditor",
          telemetry_session_id AS "telemetrySessionId",
          note,
          updated_at AS "updatedAt"
        FROM surface_activity
        WHERE repo_id = $1
          AND (
            file_path = $2
            OR file_path LIKE $3
            OR file_path LIKE $4
            OR file_path LIKE $5
          )
        ORDER BY at DESC
        LIMIT 16
      `,
      [
        params.repoId,
        params.componentId,
        `${params.componentId}/%`,
        `%/${params.componentId}/%`,
        `%/${params.componentId}.%`,
      ],
    );

    return {
      componentId: params.componentId,
      intent: `Monitor ${params.componentId} for semantic drift, complexity creep, and AI-risk changes.`,
      summary: summary.rows[0] ?? {},
      metrics: metrics.rows,
      alerts: alerts.rows,
      activity: activity.rows.map((row) => ({
        ...row,
        at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
      })),
    };
  });

  app.get("/repos/:repoId/components/:componentId/report", async (request, reply) => {
    const params = z.object({ repoId: z.string(), componentId: z.string() }).parse(request.params);
    const query = z.object({
      timeframe: z.enum(["6", "12", "24", "all"]).default("12"),
    }).parse(request.query);
    const frameLimit = query.timeframe === "6" ? 6 : query.timeframe === "24" ? 24 : query.timeframe === "all" ? 96 : 12;

    const [summary, metrics, alerts, activity] = await Promise.all([
      app.db.query(
        `
          SELECT
            ROUND(AVG(CASE WHEN key = 'cyclomatic' THEN value END)::numeric, 2) AS avg_cyclomatic,
            ROUND(AVG(CASE WHEN key = 'ai_risk_score' THEN value END)::numeric, 2) AS avg_ai_risk,
            ROUND(AVG(CASE WHEN key = 'nesting_depth' THEN value END)::numeric, 2) AS avg_nesting,
            (
              SELECT ROUND(value::numeric, 2)
              FROM metrics module_metrics
              WHERE module_metrics.repo_id = $1
                AND module_metrics.scope = 'module'
                AND module_metrics.subject_id = $2
                AND module_metrics.key = 'code_entropy_index'
              ORDER BY module_metrics.at DESC
              LIMIT 1
            ) AS entropy_index,
            (
              SELECT ROUND(value::numeric, 2)
              FROM metrics module_metrics
              WHERE module_metrics.repo_id = $1
                AND module_metrics.scope = 'module'
                AND module_metrics.subject_id = $2
                AND module_metrics.key = 'pressure_index'
              ORDER BY module_metrics.at DESC
              LIMIT 1
            ) AS pressure_index
          FROM metrics
          WHERE repo_id = $1
            AND tags ->> 'module' = $2
        `,
        [params.repoId, params.componentId],
      ),
      app.db.query(
        `
          SELECT at, key, value
          FROM metrics
          WHERE repo_id = $1
            AND (
              subject_id = $2
              OR tags ->> 'module' = $2
            )
            AND key IN ('code_entropy_index', 'pressure_index', 'ai_risk_score', 'cyclomatic')
          ORDER BY at DESC
          LIMIT $3
        `,
        [params.repoId, params.componentId, frameLimit * 8],
      ),
      app.db.query(
        `
          SELECT
            md5(CONCAT_WS('|', repo_id, COALESCE(sha, ''), at::text, type, title)) AS id,
            repo_id AS "repoId",
            at,
            severity,
            status,
            type,
            title,
            evidence,
            recommendation,
            sha
          FROM alerts
          WHERE repo_id = $1
            AND (
              evidence ->> 'module' = $2
              OR evidence ->> 'filePath' LIKE $3
            )
          ORDER BY at DESC
          LIMIT 8
        `,
        [params.repoId, params.componentId, `${params.componentId}%`],
      ),
      app.db.query(
        `
          SELECT
            COALESCE(language, 'unknown') AS language,
            COUNT(*) FILTER (WHERE parser_status = 'unsupported')::int AS "watchedOnlyEvents",
            COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::int AS "fullPipelineEvents"
          FROM surface_activity
          WHERE repo_id = $1
            AND (
              file_path = $2
              OR file_path LIKE $3
              OR file_path LIKE $4
              OR file_path LIKE $5
            )
          GROUP BY 1
          ORDER BY COUNT(*) DESC, language ASC
          LIMIT 8
        `,
        [
          params.repoId,
          params.componentId,
          `${params.componentId}/%`,
          `%/${params.componentId}/%`,
          `%/${params.componentId}.%`,
        ],
      ),
    ]);

    const trendMap = new Map<string, {
      at: string;
      entropyIndex: number;
      pressureIndex: number;
      aiRisk: number;
      cyclomatic: number;
    }>();

    for (const row of metrics.rows.reverse()) {
      const at = row.at instanceof Date ? row.at.toISOString() : String(row.at);
      const slot = trendMap.get(at) ?? { at, entropyIndex: 0, pressureIndex: 0, aiRisk: 0, cyclomatic: 0 };
      const key = String(row.key ?? "");
      if (key === "code_entropy_index") slot.entropyIndex = Number(row.value ?? 0);
      if (key === "pressure_index") slot.pressureIndex = Number(row.value ?? 0);
      if (key === "ai_risk_score") slot.aiRisk = Number(row.value ?? 0);
      if (key === "cyclomatic") slot.cyclomatic = Number(row.value ?? 0);
      trendMap.set(at, slot);
    }

    const topAlerts = alerts.rows.map((row) => ({
      ...row,
      at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    }));
    const byStatus = topAlerts.reduce<Record<string, number>>((acc, alert) => {
      const key = String(alert.status ?? "open");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    const notes: string[] = [];
    if (Number(summary.rows[0]?.pressure_index ?? 0) > 60) {
      notes.push("Module pressure is elevated. Review call depth, edge additions, and AI churn before broadening this surface.");
    }
    if ((topAlerts.length ?? 0) === 0) {
      notes.push("This component has no direct alerts right now. Use the activity lane to verify whether the module is merely quiet or under-observed.");
    }

    return {
      scope: "component",
      repoId: params.repoId,
      componentId: params.componentId,
      generatedAt: new Date().toISOString(),
      timeframe: query.timeframe,
      summary: summary.rows[0] ?? {},
      charts: {
        trend: [...trendMap.values()].slice(-frameLimit),
        modules: [
          {
            name: params.componentId,
            pressure: Number(summary.rows[0]?.pressure_index ?? 0),
            entropy: Number(summary.rows[0]?.entropy_index ?? 0),
            aiRisk: Number(summary.rows[0]?.avg_ai_risk ?? 0),
          },
        ],
        coverage: activity.rows.map((row) => ({
          language: String(row.language ?? "unknown"),
          watchedOnlyEvents: Number(row.watchedOnlyEvents ?? 0),
          fullPipelineEvents: Number(row.fullPipelineEvents ?? 0),
        })),
      },
      alerts: {
        total: topAlerts.length,
        byStatus,
        top: topAlerts,
      },
      notes,
    };
  });
}
