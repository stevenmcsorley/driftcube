import { z } from "zod";
import type { FastifyInstance } from "fastify";

export async function registerCommitRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/commits", async (request) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).parse(request.query);

    const result = await app.db.query(
      `
        SELECT repo_id AS "repoId", sha, parent_sha AS "parentSha", author, message, ts,
               provenance_hint AS "provenanceHint"
        FROM commits
        WHERE repo_id = $1
        ORDER BY ts DESC
        LIMIT $2
      `,
      [params.repoId, query.limit],
    );

    return result.rows;
  });

  app.get("/repos/:repoId/commits/:sha", async (request, reply) => {
    const params = z.object({ repoId: z.string(), sha: z.string() }).parse(request.params);
    const result = await app.db.query(
      `
        SELECT repo_id AS "repoId", sha, parent_sha AS "parentSha", author, message, ts,
               provenance_hint AS "provenanceHint"
        FROM commits
        WHERE repo_id = $1 AND sha = $2
      `,
      [params.repoId, params.sha],
    );

    if (result.rowCount === 0) {
      await reply.code(404).send({ error: "commit not found" });
      return;
    }

    const alerts = await app.db.query(
      `
        SELECT at, severity, type, title, evidence, recommendation
        FROM alerts
        WHERE repo_id = $1 AND sha = $2
        ORDER BY at DESC
      `,
      [params.repoId, params.sha],
    );

    return {
      ...result.rows[0],
      alerts: alerts.rows,
    };
  });
}

