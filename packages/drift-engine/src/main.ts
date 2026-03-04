import { connectNats, createLogger } from "@driftcube/shared";
import { QdrantClient } from "@qdrant/js-client-rest";
import neo4j from "neo4j-driver";
import { Pool } from "pg";
import { createAlertFingerprintStore } from "./alertFingerprintStore.js";
import { backfillOpenIncidents } from "./incidentTracker.js";
import { startDriftWorker } from "./worker.js";

const logger = createLogger("drift-engine");

function createNeo4jDriver(): neo4j.Driver {
  const url = process.env.NEO4J_URL ?? "bolt://127.0.0.1:7687";
  const auth = process.env.NEO4J_AUTH ?? "neo4j/password";
  const [username, password] = auth.split("/", 2);
  return neo4j.driver(url, neo4j.auth.basic(username ?? "neo4j", password ?? "password"));
}

async function main(): Promise<void> {
  const nc = await connectNats(process.env.NATS_URL ?? "nats://127.0.0.1:4222");
  const pool = new Pool({
    connectionString: process.env.PG_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/driftcube",
  });
  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://127.0.0.1:6333" });
  const driver = createNeo4jDriver();
  const fingerprintStore = await createAlertFingerprintStore();
  await backfillOpenIncidents(pool);
  startDriftWorker(nc, pool, qdrant, driver, fingerprintStore);
  logger.info("drift engine started");
}

void main().catch((error) => {
  logger.error("drift engine crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
