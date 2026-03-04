import { connectNats, createLogger } from "@driftcube/shared";
import { createQdrantClient, ensureCollections } from "./qdrant.js";
import { startEmbedderWorker } from "./worker.js";

const logger = createLogger("embedder");

async function main(): Promise<void> {
  const nc = await connectNats(process.env.NATS_URL ?? "nats://127.0.0.1:4222");
  const vectorSize = Number(process.env.EMBED_VECTOR_SIZE ?? "384");
  const qdrant = createQdrantClient();
  await ensureCollections(qdrant, vectorSize);
  startEmbedderWorker(nc, qdrant, vectorSize);
  logger.info("embedder worker started", { vectorSize });
}

void main().catch((error) => {
  logger.error("embedder crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

