import { createId, publishJson, Subjects, type AgentTelemetryReported, type Provenance } from "@driftcube/shared";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

const telemetrySchema = z.object({
  filePath: z.string().min(1),
  absolutePath: z.string().min(1).optional(),
  provenance: z.enum(["human", "claude", "codex", "cursor", "unknown"]),
  source: z.string().min(1).default("manual"),
  editor: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  observedAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function registerTelemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/repos/:repoId/telemetry/agent-events", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const body = telemetrySchema.parse(request.body);
    const observedAt = body.observedAt ?? new Date().toISOString();
    const payload: AgentTelemetryReported = {
      schemaVersion: 1,
      repoId: params.repoId,
      filePath: body.filePath,
      absolutePath: body.absolutePath,
      provenance: body.provenance as Provenance,
      source: body.source,
      editor: body.editor,
      sessionId: body.sessionId,
      metadata: body.metadata,
      observedAt,
    };

    await app.db.query(
      `
        INSERT INTO agent_telemetry (
          id, repo_id, file_path, absolute_path, provenance, source, editor, session_id, metadata, observed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      `,
      [
        createId("agtevt"),
        payload.repoId,
        payload.filePath,
        payload.absolutePath ?? null,
        payload.provenance,
        payload.source,
        payload.editor ?? null,
        payload.sessionId ?? null,
        JSON.stringify(payload.metadata ?? {}),
        payload.observedAt,
      ],
    );

    await publishJson(app.nats, Subjects.AgentTelemetryReported, payload);
    app.memoryEvents.emit(`repo:${params.repoId}`, {
      repoId: params.repoId,
      kind: "telemetry",
      provenance: payload.provenance,
      source: payload.source,
      filePath: payload.filePath,
      at: observedAt,
    });
    app.memoryEvents.emit("fleet", {
      repoId: params.repoId,
      kind: "telemetry",
      provenance: payload.provenance,
      source: payload.source,
      filePath: payload.filePath,
      at: observedAt,
    });

    await reply.code(202).send({
      accepted: true,
      repoId: params.repoId,
      filePath: payload.filePath,
      provenance: payload.provenance,
      source: payload.source,
      observedAt,
    });
  });
}
