import { createId } from "@driftcube/shared";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

const gateSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.any()),
});

export async function registerGateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/gates", async (request) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const result = await app.db.query(
      `
        SELECT gate_id AS "gateId", name, enabled, config, created_at AS "createdAt"
        FROM gates
        WHERE repo_id = $1
        ORDER BY created_at DESC
      `,
      [params.repoId],
    );

    return result.rows;
  });

  app.post("/repos/:repoId/gates", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const body = gateSchema.parse(request.body);
    const gateId = createId("gate");

    await app.db.query(
      `
        INSERT INTO gates (repo_id, gate_id, name, enabled, config, created_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
      `,
      [params.repoId, gateId, body.name, body.enabled, JSON.stringify(body.config)],
    );

    await reply.code(201).send({ gateId, ...body });
  });

  app.patch("/repos/:repoId/gates/:gateId", async (request) => {
    const params = z.object({ repoId: z.string(), gateId: z.string() }).parse(request.params);
    const body = gateSchema.partial().parse(request.body);

    await app.db.query(
      `
        UPDATE gates
        SET name = COALESCE($3, name),
            enabled = COALESCE($4, enabled),
            config = COALESCE($5::jsonb, config)
        WHERE repo_id = $1 AND gate_id = $2
      `,
      [
        params.repoId,
        params.gateId,
        body.name ?? null,
        body.enabled ?? null,
        body.config ? JSON.stringify(body.config) : null,
      ],
    );

    return { ok: true };
  });
}

