import { createLogger } from "@driftcube/shared";

const logger = createLogger("git-poller");

export function startGitPoller(): void {
  logger.info("git polling is not enabled in v1", {
    status: "stub",
  });
}

