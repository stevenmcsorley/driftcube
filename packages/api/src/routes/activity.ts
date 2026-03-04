import { z } from "zod";
import type { FastifyInstance } from "fastify";

function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/activity", async (request) => {
    const params = z.object({
      repoId: z.string(),
    }).parse(request.params);
    const query = z.object({
      page: z.coerce.number().min(1).default(1),
      limit: z.coerce.number().min(1).max(100).default(12),
      mode: z.enum(["all", "full", "watched"]).default("all"),
      parserStatus: z.enum(["pending", "analyzed", "unsupported", "no_symbols"]).optional(),
    }).parse(request.query);

    const values: unknown[] = [params.repoId];
    const filters = ["repo_id = $1"];

    if (query.mode === "full") {
      filters.push("parser_status IN ('pending', 'analyzed', 'no_symbols')");
    } else if (query.mode === "watched") {
      filters.push("parser_status = 'unsupported'");
    } else if (query.parserStatus) {
      values.push(query.parserStatus);
      filters.push(`parser_status = $${values.length}`);
    }

    const countResult = await app.db.query<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM surface_activity
        WHERE ${filters.join(" AND ")}
      `,
      values,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);
    const offset = (query.page - 1) * query.limit;
    const rowValues = [...values, query.limit, offset];

    const result = await app.db.query(
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
        WHERE ${filters.join(" AND ")}
        ORDER BY at DESC
        LIMIT $${rowValues.length - 1}
        OFFSET $${rowValues.length}
      `,
      rowValues,
    );

    const languageCoverage = await app.db.query(
      `
        SELECT
          COALESCE(language, 'unknown') AS language,
          COUNT(*)::int AS "totalEvents",
          COUNT(*) FILTER (WHERE parser_status = 'unsupported')::int AS "watchedOnlyEvents",
          COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::int AS "fullPipelineEvents",
          COUNT(*) FILTER (WHERE parser_status = 'analyzed')::int AS "analyzedEvents",
          ROUND(
            (
              COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::numeric
              / NULLIF(COUNT(*), 0)
            ) * 100,
            1
          ) AS "coveragePercent"
        FROM surface_activity
        WHERE repo_id = $1
          AND at >= NOW() - INTERVAL '24 hours'
        GROUP BY COALESCE(language, 'unknown')
        ORDER BY "watchedOnlyEvents" DESC, "totalEvents" DESC, language ASC
        LIMIT 10
      `,
      [params.repoId],
    );

    return {
      items: result.rows.map((row) => ({
        ...row,
        at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
      })),
      languageCoverage: languageCoverage.rows,
      total,
      page: query.page,
      pageSize: query.limit,
      mode: query.mode,
      totalPages: totalPages(total, query.limit),
    };
  });
}
