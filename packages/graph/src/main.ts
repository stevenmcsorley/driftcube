import { connectNats, createLogger } from "@driftcube/shared";
import { createNeo4jDriver } from "./neo4j.js";
import { startGraphWorker } from "./worker.js";

const logger = createLogger("graph");

async function main(): Promise<void> {
  const nc = await connectNats(process.env.NATS_URL ?? "nats://127.0.0.1:4222");
  const driver = createNeo4jDriver();
  startGraphWorker(nc, driver);
  logger.info("graph worker started");
}

void main().catch((error) => {
  logger.error("graph worker crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

