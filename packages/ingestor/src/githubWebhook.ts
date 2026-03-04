import { createLogger } from "@driftcube/shared";

const logger = createLogger("github-webhook");

export function describeGithubWebhookMode(): void {
  logger.info("github webhook ingestion will be added behind the api service", {
    status: "stub",
  });
}

