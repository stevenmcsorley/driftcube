import { connectNats, createLogger } from "@driftcube/shared";
import { QdrantClient } from "@qdrant/js-client-rest";
import { createPool } from "./db.js";
import { startMetricsWorker } from "./worker.js";

const logger = createLogger("metrics");

async function main(): Promise<void> {
  const nc = await connectNats(process.env.NATS_URL ?? "nats://127.0.0.1:4222");
  const pool = createPool();
  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://127.0.0.1:6333" });
  startMetricsWorker(nc, pool, qdrant);
  logger.info("metrics worker started");
}

void main().catch((error) => {
  logger.error("metrics crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
