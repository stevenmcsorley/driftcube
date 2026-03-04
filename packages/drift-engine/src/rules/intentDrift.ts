import type { QdrantClient } from "@qdrant/js-client-rest";
import { createStablePointId, type AlertRaised, type EmbeddingsUpserted } from "@driftcube/shared";

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

export async function detectIntentDrift(qdrant: QdrantClient, event: EmbeddingsUpserted): Promise<AlertRaised[]> {
  const alerts: AlertRaised[] = [];

  for (const upsert of event.upserts) {
    const module = String(upsert.payload.module ?? "root");
    const point = (await qdrant.retrieve("symbols_v1", {
      ids: [createStablePointId(String(upsert.payload.symbolId ?? upsert.id))],
      with_vector: true,
    }))[0];

    const vector = asDenseVector(point?.vector);
    if (vector.length === 0) {
      continue;
    }

    const neighbours = await qdrant.search("symbols_v1", {
      vector,
      limit: 6,
      with_payload: true,
      filter: {
        must: [
          { key: "repoId", match: { value: event.repoId } },
          { key: "module", match: { value: module } },
        ],
        must_not: [
          { key: "symbolId", match: { value: upsert.id } },
        ],
      },
    });

    const avgScore = neighbours.length === 0
      ? 1
      : neighbours.reduce((sum, item) => sum + item.score, 0) / neighbours.length;

    if (neighbours.length >= 3 && avgScore < 0.55) {
      alerts.push({
        schemaVersion: 1,
        repoId: event.repoId,
        commitSha: event.commitSha,
        at: new Date().toISOString(),
        severity: "warn",
        type: "INTENT_DRIFT",
        title: `Module intent drift detected in ${module}`,
        evidence: {
          filePath: String(upsert.payload.filePath ?? ""),
          symbolId: String(upsert.payload.symbolId ?? upsert.id),
          module,
          neighbours: neighbours.map((item) => ({
            id: String(item.payload?.symbolId ?? item.id),
            score: item.score,
          })),
        },
        recommendation: "Check whether this symbol still belongs in the current module or needs an intent update.",
      });
    }
  }

  return alerts;
}
