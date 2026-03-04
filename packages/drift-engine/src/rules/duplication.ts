import type { QdrantClient } from "@qdrant/js-client-rest";
import { createStablePointId, type AlertRaised, type EmbeddingsUpserted, type Severity } from "@driftcube/shared";

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

function scoreToSeverity(score: number, provenance?: string): Severity {
  if (score > 0.98 && provenance && provenance !== "human" && provenance !== "unknown") {
    return "error";
  }

  return score > 0.95 ? "warn" : "info";
}

export async function detectSemanticDuplication(
  qdrant: QdrantClient,
  event: EmbeddingsUpserted,
): Promise<AlertRaised[]> {
  const alerts: AlertRaised[] = [];

  for (const upsert of event.upserts) {
    const point = (await qdrant.retrieve("symbols_v1", {
      ids: [createStablePointId(String(upsert.payload.symbolId ?? upsert.id))],
      with_vector: true,
      with_payload: true,
    }))[0];

    const vector = asDenseVector(point?.vector);
    if (vector.length === 0) {
      continue;
    }

    const search = await qdrant.search("symbols_v1", {
      vector,
      limit: 4,
      with_payload: true,
      score_threshold: 0.92,
      filter: {
        must: [
          {
            key: "repoId",
            match: { value: event.repoId },
          },
        ],
        must_not: [
          {
            key: "symbolId",
            match: { value: upsert.id },
          },
        ],
      },
    });

    const neighbour = search.find((candidate) => {
      const candidateNormHash = candidate.payload?.normHash;
      const currentNormHash = upsert.payload.normHash;
      return candidateNormHash !== currentNormHash;
    });

    if (!neighbour) {
      continue;
    }

    alerts.push({
      schemaVersion: 1,
      repoId: event.repoId,
      commitSha: event.commitSha,
      at: new Date().toISOString(),
      severity: scoreToSeverity(neighbour.score, String(upsert.payload.provenance ?? "unknown")),
      type: "SEMANTIC_DUPLICATION",
      title: `Near-duplicate logic detected for ${String(upsert.payload.symbolId ?? upsert.id)}`,
      evidence: {
        filePath: String(upsert.payload.filePath ?? ""),
        symbolId: String(upsert.payload.symbolId ?? upsert.id),
        neighbours: [
          {
            id: String(neighbour.id),
            score: neighbour.score,
          },
        ],
      },
      recommendation: "Review the neighbouring implementation and collapse paraphrased duplicate logic.",
    });
  }

  return alerts;
}
