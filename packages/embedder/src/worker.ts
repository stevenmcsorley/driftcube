import { Subjects, createStablePointId, publishJson, subscribeJson, type EmbeddingsUpserted, type SymbolsExtracted } from "@driftcube/shared";
import { createLogger } from "@driftcube/shared";
import type { NatsConnection } from "nats";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { embedText } from "./embed.js";

const logger = createLogger("embedder");

export function startEmbedderWorker(nc: NatsConnection, qdrant: QdrantClient, vectorSize: number): void {
  subscribeJson<SymbolsExtracted>(nc, Subjects.SymbolsExtracted, async (event) => {
    if (event.symbols.length === 0) {
      return;
    }

    const points = event.symbols.map((symbol) => ({
      id: createStablePointId(symbol.symbolId),
      vector: embedText(symbol.bodyText ?? symbol.name, vectorSize),
      payload: {
        repoId: event.repoId,
        commitSha: event.commitSha,
        filePath: event.filePath,
        symbolId: symbol.symbolId,
        language: event.language,
        kind: symbol.kind,
        module: symbol.modulePath ?? "root",
        provenance: symbol.provenance ?? "unknown",
        normHash: symbol.normHash,
        tokensHash: symbol.tokensHash,
      },
    }));

    await qdrant.upsert("symbols_v1", {
      wait: true,
      points,
    });

    const payload: EmbeddingsUpserted = {
      schemaVersion: 1,
      repoId: event.repoId,
      commitSha: event.commitSha,
      collection: "symbols_v1",
      upserts: points.map((point) => ({
        id: String(point.id),
        vectorDim: vectorSize,
        payload: point.payload,
      })),
    };

    logger.info("embeddings upserted", {
      repoId: event.repoId,
      filePath: event.filePath,
      count: points.length,
    });
    await publishJson(nc, Subjects.EmbeddingsUpserted, payload);
  });
}
