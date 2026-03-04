import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { publishJson, Subjects, type RefactorRefreshRequested, type RefactorStatus, type RefactorSuggestion } from "@driftcube/shared";

function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

function rowToSuggestion(repoId: string, row: Record<string, unknown>): RefactorSuggestion {
  return {
    id: String(row.id ?? ""),
    repoId,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at ?? new Date().toISOString()),
    scope: String(row.scope ?? "module") as RefactorSuggestion["scope"],
    target: String(row.target ?? ""),
    type: String(row.type ?? "EXTRACT_MODULE") as RefactorSuggestion["type"],
    confidence: Number(row.confidence ?? 0),
    impact: (row.impact && typeof row.impact === "object" ? row.impact : {}) as RefactorSuggestion["impact"],
    simulation: (row.simulation && typeof row.simulation === "object" ? row.simulation : undefined) as RefactorSuggestion["simulation"],
    evidence: (row.evidence && typeof row.evidence === "object" ? row.evidence : {
      topDrivers: [],
      entities: {},
    }) as RefactorSuggestion["evidence"],
    plan: Array.isArray(row.plan) ? row.plan.map((entry) => String(entry)) : [],
    status: String(row.status ?? "proposed") as RefactorStatus,
  };
}

const STATUS_RANK: Record<RefactorStatus, number> = {
  applied: 0,
  accepted: 1,
  proposed: 2,
  dismissed: 3,
};

const ALLOWED_TRANSITIONS: Record<RefactorStatus, RefactorStatus[]> = {
  proposed: ["accepted", "dismissed"],
  accepted: ["proposed", "applied", "dismissed"],
  applied: ["accepted"],
  dismissed: ["proposed"],
};

export async function registerRefactorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/refactors", async (request) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const query = z.object({
      page: z.coerce.number().min(1).default(1),
      limit: z.coerce.number().min(1).max(100).default(8),
      type: z.string().optional(),
      status: z.enum(["proposed", "accepted", "applied", "dismissed"]).optional(),
    }).parse(request.query);

    const values: unknown[] = [params.repoId];
    const filters = ["repo_id = $1"];

    if (query.type) {
      values.push(query.type);
      filters.push(`type = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      filters.push(`status = $${values.length}`);
    }

    const countResult = await app.db.query<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM refactor_suggestions
        WHERE ${filters.join(" AND ")}
      `,
      values,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);
    const offset = (query.page - 1) * query.limit;
    const rowValues = [...values, query.limit, offset];

    const result = await app.db.query(
      `
        SELECT id, at, scope, target, type, confidence, impact, simulation, evidence, plan, status
        FROM refactor_suggestions
        WHERE ${filters.join(" AND ")}
        ORDER BY
          CASE status
            WHEN 'applied' THEN 0
            WHEN 'accepted' THEN 1
            WHEN 'proposed' THEN 2
            ELSE 3
          END ASC,
          confidence DESC,
          at DESC
        LIMIT $${rowValues.length - 1}
        OFFSET $${rowValues.length}
      `,
      rowValues,
    );

    return {
      items: result.rows.map((row) => rowToSuggestion(params.repoId, row)),
      total,
      page: query.page,
      pageSize: query.limit,
      totalPages: totalPages(total, query.limit),
    };
  });

  app.post("/repos/:repoId/refactors/generate", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);

    const repo = await app.db.query(
      `SELECT repo_id FROM repos WHERE repo_id = $1`,
      [params.repoId],
    );

    if (repo.rowCount === 0) {
      await reply.code(404).send({ error: "repo not found" });
      return;
    }

    const refreshEvent: RefactorRefreshRequested = {
      schemaVersion: 1,
      repoId: params.repoId,
      reason: "manual-request",
      trigger: "api",
      requestedAt: new Date().toISOString(),
    };
    await publishJson(app.nats, Subjects.RefactorRefreshRequested, refreshEvent);

    const persisted = await app.db.query(
      `
        SELECT id, at, scope, target, type, confidence, impact, simulation, evidence, plan, status
        FROM refactor_suggestions
        WHERE repo_id = $1
        ORDER BY
          CASE status
            WHEN 'applied' THEN 0
            WHEN 'accepted' THEN 1
            WHEN 'proposed' THEN 2
            ELSE 3
          END ASC,
          confidence DESC,
          at DESC
      `,
      [params.repoId],
    );

    return {
      repoId: params.repoId,
      generatedAt: new Date().toISOString(),
      total: persisted.rowCount ?? 0,
      items: persisted.rows.map((row) => rowToSuggestion(params.repoId, row)),
      queued: true,
    };
  });

  app.patch("/repos/:repoId/refactors/:refactorId", async (request, reply) => {
    const params = z.object({
      repoId: z.string(),
      refactorId: z.string(),
    }).parse(request.params);
    const body = z.object({
      status: z.enum(["proposed", "accepted", "applied", "dismissed"]),
    }).parse(request.body);

    const current = await app.db.query(
      `
        SELECT id, at, scope, target, type, confidence, impact, simulation, evidence, plan, status
        FROM refactor_suggestions
        WHERE repo_id = $1
          AND id = $2
        LIMIT 1
      `,
      [params.repoId, params.refactorId],
    );

    if ((current.rowCount ?? 0) === 0) {
      await reply.code(404).send({ error: "refactor suggestion not found" });
      return;
    }

    const currentStatus = String(current.rows[0]?.status ?? "proposed") as RefactorStatus;
    if (!ALLOWED_TRANSITIONS[currentStatus]?.includes(body.status)) {
      await reply.code(400).send({
        error: "invalid status transition",
        from: currentStatus,
        to: body.status,
      });
      return;
    }

    await app.db.query(
      `
        UPDATE refactor_suggestions
        SET status = $3
        WHERE repo_id = $1
          AND id = $2
      `,
      [params.repoId, params.refactorId, body.status],
    );

    const updated = await app.db.query(
      `
        SELECT id, at, scope, target, type, confidence, impact, simulation, evidence, plan, status
        FROM refactor_suggestions
        WHERE repo_id = $1
          AND id = $2
      `,
      [params.repoId, params.refactorId],
    );

    const suggestion = rowToSuggestion(params.repoId, updated.rows[0] ?? {});
    const rank = STATUS_RANK[suggestion.status ?? "proposed"];

    if (body.status === "applied") {
      const linkedAlerts = await app.db.query<{ alertId: string }>(
        `
          SELECT alert_id AS "alertId"
          FROM alert_refactor_links
          WHERE repo_id = $1
            AND refactor_id = $2
        `,
        [params.repoId, params.refactorId],
      );

      if (linkedAlerts.rows.length > 0) {
        for (const row of linkedAlerts.rows) {
          await app.db.query(
            `
              UPDATE alerts
              SET
                status = 'resolved',
                resolved_at = NOW(),
                resolved_by = 'driftcube-refactor',
                status_updated_at = NOW()
              WHERE repo_id = $1
                AND md5(CONCAT_WS('|', repo_id, COALESCE(sha, ''), at::text, type, title)) = $2
                AND status <> 'resolved'
            `,
            [params.repoId, row.alertId],
          );

          await app.db.query(
            `
              INSERT INTO alert_comments (id, repo_id, alert_id, kind, author, body)
              VALUES ($1, $2, $3, 'fix', 'driftcube', $4)
            `,
            [
              `comment_${randomUUID()}`,
              params.repoId,
              row.alertId,
              `Linked refactor ${suggestion.type.replaceAll("_", " ")} on ${suggestion.target} was marked applied.`,
            ],
          );
        }
      }
    }

    return {
      item: suggestion,
      rank,
      updatedAt: new Date().toISOString(),
    };
  });
}
