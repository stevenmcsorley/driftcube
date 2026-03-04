import { createStablePointId } from "@driftcube/shared";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

function asDenseVector(vector: unknown): number[] {
  if (Array.isArray(vector) && vector.every((item) => typeof item === "number")) {
    return vector as number[];
  }

  if (Array.isArray(vector) && Array.isArray(vector[0])) {
    const first = vector[0];
    return Array.isArray(first) ? first.filter((item): item is number => typeof item === "number") : [];
  }

  return [];
}

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/search/similar", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const query = z.object({
      symbolId: z.string(),
      k: z.coerce.number().min(1).max(25).default(10),
    }).parse(request.query);

    const point = (await app.qdrant.retrieve("symbols_v1", {
      ids: [createStablePointId(query.symbolId)],
      with_vector: true,
      with_payload: true,
    }))[0];

    const vector = asDenseVector(point?.vector);
    if (vector.length === 0) {
      await reply.code(404).send({ error: "symbol not found in vector index" });
      return;
    }

    const results = await app.qdrant.search("symbols_v1", {
      vector,
      limit: query.k,
      with_payload: true,
      filter: {
        must: [
          { key: "repoId", match: { value: params.repoId } },
        ],
        must_not: [
          { key: "symbolId", match: { value: query.symbolId } },
        ],
      },
    });

    return results.map((item) => ({
      id: item.payload?.symbolId ?? item.id,
      score: item.score,
      payload: item.payload,
    }));
  });
}
