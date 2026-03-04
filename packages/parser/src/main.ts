import { connectNats, createLogger } from "@driftcube/shared";
import { startParserWorker } from "./worker.js";

const logger = createLogger("parser");

async function main(): Promise<void> {
  const nc = await connectNats(process.env.NATS_URL ?? "nats://127.0.0.1:4222");
  startParserWorker(nc);
  logger.info("parser worker started");
}

void main().catch((error) => {
  logger.error("parser crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

