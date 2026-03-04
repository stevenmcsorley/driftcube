import { relative, resolve } from "node:path";
import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { createLogger } from "@driftcube/shared";
import type { NatsConnection } from "nats";
import type { Pool } from "pg";
import { publishLocalChange } from "./publisher.js";

const logger = createLogger("ingestor");

function detectLanguage(path: string): string | undefined {
  const normalized = path.toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  if (basename === "dockerfile" || basename.startsWith("dockerfile.")) return "dockerfile";
  if ((normalized.startsWith(".github/workflows/") || normalized.includes("/.github/workflows/")) && (path.endsWith(".yml") || path.endsWith(".yaml"))) return "workflow";
  if (basename === ".gitlab-ci.yml" || basename === "azure-pipelines.yml" || basename === "buildkite.yml") return "workflow";
  if (normalized.includes("/.circleci/config.yml")) return "workflow";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".scss") || path.endsWith(".sass")) return "scss";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md") || path.endsWith(".mdx")) return "markdown";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".xml")) return "xml";
  if (path.endsWith(".toml")) return "toml";
  if (path.endsWith(".ini") || path.endsWith(".conf") || path.endsWith(".cfg")) return "config";
  if (basename === ".env" || basename.startsWith(".env.")) return "config";
  return undefined;
}

export function watchLocalRepo(
  nc: NatsConnection,
  rootPath: string,
  repoId: string,
  pool: Pool,
): FSWatcher {
  const absoluteRoot = resolve(rootPath);
  const watcher = chokidar.watch(absoluteRoot, {
    ignored: (inputPath) => {
      const normalized = inputPath.replace(/\\/g, "/");
      const basename = normalized.split("/").pop() ?? normalized;
      if (basename === ".env" || basename.startsWith(".env.")) {
        return false;
      }
      if (basename === ".gitlab-ci.yml") {
        return false;
      }
      if (normalized.endsWith("/.github") || normalized.includes("/.github/")) {
        return false;
      }
      if (normalized.endsWith("/.circleci") || normalized.includes("/.circleci/")) {
        return false;
      }

      return /(^|\/)\./.test(normalized)
        || /(^|\/)node_modules(\/|$)/.test(normalized)
        || /(^|\/)dist(\/|$)/.test(normalized)
        || /(^|\/)\.next(\/|$)/.test(normalized);
    },
    ignoreInitial: true,
    persistent: true,
  });

  const emit = async (absolutePath: string, changeType: "added" | "modified" | "deleted") => {
    const filePath = relative(absoluteRoot, absolutePath);
    if (!filePath || filePath.startsWith("..")) {
      return;
    }

    const telemetry = await pool.query<{
      provenance: string | null;
      source: string | null;
      editor: string | null;
      sessionId: string | null;
    }>(
      `
        SELECT
          provenance,
          source,
          editor,
          session_id AS "sessionId"
        FROM agent_telemetry
        WHERE repo_id = $1
          AND (
            file_path = $2
            OR absolute_path = $3
          )
          AND observed_at >= NOW() - INTERVAL '45 minutes'
        ORDER BY observed_at DESC
        LIMIT 1
      `,
      [repoId, filePath, absolutePath],
    );
    const latestTelemetry = telemetry.rows[0];

    await publishLocalChange(nc, {
      repoId,
      rootPath: absoluteRoot,
      path: filePath,
      absolutePath,
      changeType,
      language: detectLanguage(filePath),
      provenance: latestTelemetry?.provenance === "human"
        || latestTelemetry?.provenance === "claude"
        || latestTelemetry?.provenance === "codex"
        || latestTelemetry?.provenance === "cursor"
        || latestTelemetry?.provenance === "unknown"
        ? latestTelemetry.provenance
        : undefined,
      telemetrySource: latestTelemetry?.source ?? undefined,
      telemetryEditor: latestTelemetry?.editor ?? undefined,
      telemetrySessionId: latestTelemetry?.sessionId ?? undefined,
    });
  };

  watcher.on("add", (path) => {
    logger.info("file added", { repoId, path });
    void emit(path, "added");
  });

  watcher.on("change", (path) => {
    logger.info("file changed", { repoId, path });
    void emit(path, "modified");
  });

  watcher.on("unlink", (path) => {
    logger.info("file deleted", { repoId, path });
    void emit(path, "deleted");
  });

  return watcher;
}
