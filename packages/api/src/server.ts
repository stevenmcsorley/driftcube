import Fastify from "fastify";
import cors from "@fastify/cors";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { QdrantClient } from "@qdrant/js-client-rest";
import neo4j from "neo4j-driver";
import {
  createId,
  connectNats,
  createLogger,
  subscribeJson,
  Subjects,
  type AgentTelemetryReported,
  type AlertRaised,
  type CommitDetected,
  type FilesChanged,
  type MetricsWritten,
  type RefactorSuggestionsUpdated,
  type RepoRegistered,
  type SymbolsExtracted,
} from "@driftcube/shared";
import { Pool } from "pg";
import { requireAuth } from "./auth.js";
import { normalizeLegacyContentHeuristics } from "./lib/contentHeuristicNormalization.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerCommitRoutes } from "./routes/commits.js";
import { registerComponentRoutes } from "./routes/components.js";
import { registerEntropyRoutes } from "./routes/entropy.js";
import { registerGateRoutes } from "./routes/gates.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerOverviewRoutes } from "./routes/overview.js";
import { registerRefactorRoutes } from "./routes/refactors.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSimilarityRoutes } from "./routes/similarity.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    nats: Awaited<ReturnType<typeof connectNats>>;
    qdrant: QdrantClient;
    neo4j: neo4j.Driver;
    memoryEvents: EventEmitter;
  }
}

const logger = createLogger("api");

function parserStatusForLanguage(language: string | undefined): { status: string; note: string | null } {
  if (!language) {
    return {
      status: "unsupported",
      note: "Watched file changed, but DriftCube could not infer an analyzable language.",
    };
  }

  if (["typescript", "javascript", "python"].includes(language)) {
    return {
      status: "pending",
      note: null,
    };
  }

  if (["css", "scss", "json", "markdown", "yaml", "html", "toml", "config", "xml", "dockerfile", "workflow"].includes(language)) {
    return {
      status: "unsupported",
      note: `Watched with lightweight heuristics. ${language} files can raise content drift warnings, but they do not enter the full graph or symbol pipeline.`,
    };
  }

  return {
    status: "unsupported",
    note: `Watched only. ${language} changes are visible in the activity stream but not analyzed yet.`,
  };
}

function neo4jAuthToken() {
  const rawAuth = process.env.NEO4J_AUTH ?? "neo4j/password";
  const [username, ...passwordParts] = rawAuth.split("/");
  return neo4j.auth.basic(username || "neo4j", passwordParts.join("/") || "password");
}

async function buildServer() {
  const app = Fastify({ logger: false });
  app.db = new Pool({
    connectionString: process.env.PG_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/driftcube",
  });
  app.nats = await connectNats(process.env.NATS_URL ?? "nats://127.0.0.1:4222");
  app.qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://127.0.0.1:6333" });
  app.neo4j = neo4j.driver(process.env.NEO4J_URL ?? "bolt://127.0.0.1:7687", neo4jAuthToken());
  app.memoryEvents = new EventEmitter();
  app.memoryEvents.setMaxListeners(200);

  const normalizedAlerts = await normalizeLegacyContentHeuristics(app.db);
  if (normalizedAlerts > 0) {
    logger.info("normalized legacy content heuristic alerts", { count: normalizedAlerts });
  }

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  app.addHook("preHandler", requireAuth);

  subscribeJson<RepoRegistered>(app.nats, Subjects.RepoRegistered, async (event) => {
    await app.db.query(
      `
        INSERT INTO repos (repo_id, name, kind, host_path, root_path, remote_url, default_branch, watch_enabled, watch_state, watch_error, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (repo_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          kind = EXCLUDED.kind,
          host_path = EXCLUDED.host_path,
          root_path = EXCLUDED.root_path,
          remote_url = EXCLUDED.remote_url,
          default_branch = EXCLUDED.default_branch,
          watch_enabled = EXCLUDED.watch_enabled,
          watch_state = EXCLUDED.watch_state,
          watch_error = EXCLUDED.watch_error
      `,
      [
        event.repoId,
        event.name,
        event.kind,
        event.hostPath ?? null,
        event.rootPath ?? null,
        event.remoteUrl ?? null,
        event.defaultBranch,
        event.watchEnabled ?? true,
        event.watchState ?? "pending",
        event.watchError ?? null,
        event.createdAt,
      ],
    );

    app.memoryEvents.emit("fleet", {
      kind: "repo",
      repoId: event.repoId,
      at: new Date().toISOString(),
    });
  });

  subscribeJson<CommitDetected>(app.nats, Subjects.CommitDetected, async (event) => {
    await app.db.query(
      `
        INSERT INTO commits (repo_id, sha, parent_sha, author, message, ts, provenance_hint)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (repo_id, sha)
        DO UPDATE SET
          parent_sha = EXCLUDED.parent_sha,
          author = EXCLUDED.author,
          message = EXCLUDED.message,
          ts = EXCLUDED.ts,
          provenance_hint = EXCLUDED.provenance_hint
      `,
      [
        event.repoId,
        event.commitSha,
        event.parentSha ?? null,
        event.author ?? null,
        event.message ?? null,
        event.timestamp,
        event.provenanceHint ?? null,
      ],
    );
  });

  subscribeJson<FilesChanged>(app.nats, Subjects.FilesChanged, async (event) => {
    for (const change of event.changes) {
      const activityId = `${event.commitSha}:${change.path}`;
      const parserState = parserStatusForLanguage(change.language);
      await app.db.query(
        `
          INSERT INTO surface_activity (
            event_id, repo_id, commit_sha, at, file_path, absolute_path, language, change_type,
            parser_status, symbol_count, alert_count, note, updated_at
          )
          VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, 0, 0, $9, NOW())
          ON CONFLICT (event_id)
          DO UPDATE SET
            absolute_path = EXCLUDED.absolute_path,
            language = EXCLUDED.language,
            change_type = EXCLUDED.change_type,
            parser_status = EXCLUDED.parser_status,
            note = EXCLUDED.note,
            updated_at = NOW()
        `,
        [
          activityId,
          event.repoId,
          event.commitSha,
          change.path,
          change.absolutePath ?? null,
          change.language ?? null,
          change.changeType,
          parserState.status,
          parserState.note,
        ],
      );

      if (change.provenance || change.telemetrySource || change.telemetryEditor || change.telemetrySessionId) {
        await app.db.query(
          `
            UPDATE surface_activity
            SET
              provenance = COALESCE($4, provenance),
              telemetry_source = COALESCE($5, telemetry_source),
              telemetry_editor = COALESCE($6, telemetry_editor),
              telemetry_session_id = COALESCE($7, telemetry_session_id),
              updated_at = NOW()
            WHERE event_id = $1
              AND repo_id = $2
              AND commit_sha = $3
          `,
          [
            activityId,
            event.repoId,
            event.commitSha,
            change.provenance ?? null,
            change.telemetrySource ?? null,
            change.telemetryEditor ?? null,
            change.telemetrySessionId ?? null,
          ],
        );
      }

      if (change.absolutePath && change.changeType !== "deleted") {
        try {
          const content = await readFile(change.absolutePath, "utf8");
          if (content.length <= 200_000) {
            await app.db.query(
              `
                INSERT INTO file_snapshots (id, repo_id, file_path, absolute_path, observed_at, content)
                VALUES ($1, $2, $3, $4, NOW(), $5)
              `,
              [
                createId("snapshot"),
                event.repoId,
                change.path,
                change.absolutePath,
                content,
              ],
            );
          }
        } catch (error) {
          logger.warn("failed to store file snapshot", {
            repoId: event.repoId,
            filePath: change.path,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }
      }

      app.memoryEvents.emit(`repo:${event.repoId}`, {
        repoId: event.repoId,
        kind: "activity",
        at: new Date().toISOString(),
        commitSha: event.commitSha,
        filePath: change.path,
        parserStatus: parserState.status,
      });
      app.memoryEvents.emit("fleet", {
        repoId: event.repoId,
        kind: "activity",
        at: new Date().toISOString(),
        commitSha: event.commitSha,
        filePath: change.path,
        parserStatus: parserState.status,
      });
    }
  });

  subscribeJson<SymbolsExtracted>(app.nats, Subjects.SymbolsExtracted, async (event) => {
    await app.db.query(
      `
        UPDATE surface_activity
        SET
          parser_status = $4,
          symbol_count = $5,
          note = $6,
          updated_at = NOW()
        WHERE repo_id = $1
          AND commit_sha = $2
          AND file_path = $3
      `,
      [
        event.repoId,
        event.commitSha,
        event.filePath,
        event.symbols.length > 0 ? "analyzed" : "no_symbols",
        event.symbols.length,
        event.symbols.length > 0
          ? `Analyzed ${event.symbols.length} symbol${event.symbols.length === 1 ? "" : "s"}.`
          : "Parsed successfully, but no top-level analyzable symbols were found.",
      ],
    );

    app.memoryEvents.emit(`repo:${event.repoId}`, {
      repoId: event.repoId,
      kind: "activity",
      at: new Date().toISOString(),
      commitSha: event.commitSha,
      filePath: event.filePath,
      parserStatus: event.symbols.length > 0 ? "analyzed" : "no_symbols",
    });
    app.memoryEvents.emit("fleet", {
      repoId: event.repoId,
      kind: "activity",
      at: new Date().toISOString(),
      commitSha: event.commitSha,
      filePath: event.filePath,
      parserStatus: event.symbols.length > 0 ? "analyzed" : "no_symbols",
    });
  });

  subscribeJson<MetricsWritten>(app.nats, Subjects.MetricsWritten, async (event) => {
    app.memoryEvents.emit(`repo:${event.repoId}`, {
      repoId: event.repoId,
      kind: "metrics",
      at: event.at,
      commitSha: event.commitSha,
    });
    app.memoryEvents.emit("fleet", {
      repoId: event.repoId,
      kind: "metrics",
      at: event.at,
      commitSha: event.commitSha,
    });
  });

  subscribeJson<AlertRaised>(app.nats, Subjects.AlertRaised, async (event) => {
    await app.db.query(
      `
        INSERT INTO alerts (repo_id, sha, at, severity, type, title, evidence, recommendation)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        ON CONFLICT (repo_id, sha, at, type, title)
        DO NOTHING
      `,
      [
        event.repoId,
        event.commitSha,
        event.at,
        event.severity,
        event.type,
        event.title,
        JSON.stringify(event.evidence ?? {}),
        event.recommendation ?? null,
      ],
    );

    if (event.evidence.filePath) {
      await app.db.query(
        `
          UPDATE surface_activity
          SET
            alert_count = alert_count + 1,
            updated_at = NOW(),
            note = COALESCE(note, 'Analyzed.') || ' Alert raised: ' || $4
          WHERE repo_id = $1
            AND commit_sha = $2
            AND file_path = $3
        `,
        [event.repoId, event.commitSha, event.evidence.filePath, event.type],
      );
    }

    app.memoryEvents.emit(`repo:${event.repoId}`, {
      repoId: event.repoId,
      kind: "alert",
      at: event.at,
      commitSha: event.commitSha,
      type: event.type,
      severity: event.severity,
    });
    app.memoryEvents.emit("fleet", {
      repoId: event.repoId,
      kind: "alert",
      at: event.at,
      commitSha: event.commitSha,
      type: event.type,
      severity: event.severity,
    });
  });

  subscribeJson<AgentTelemetryReported>(app.nats, Subjects.AgentTelemetryReported, async (event) => {
    const duplicate = await app.db.query(
      `
        SELECT 1
        FROM agent_telemetry
        WHERE repo_id = $1
          AND file_path = $2
          AND provenance = $3
          AND source = $4
          AND COALESCE(session_id, '') = COALESCE($5, '')
          AND observed_at = $6
        LIMIT 1
      `,
      [event.repoId, event.filePath, event.provenance, event.source, event.sessionId ?? null, event.observedAt],
    );

    if ((duplicate.rowCount ?? 0) === 0) {
      await app.db.query(
        `
          INSERT INTO agent_telemetry (
            id, repo_id, file_path, absolute_path, provenance, source, editor, session_id, metadata, observed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        `,
        [
          createId("agtevt"),
          event.repoId,
          event.filePath,
          event.absolutePath ?? null,
          event.provenance,
          event.source,
          event.editor ?? null,
          event.sessionId ?? null,
          JSON.stringify(event.metadata ?? {}),
          event.observedAt,
        ],
      );
    }
  });

  subscribeJson<RefactorSuggestionsUpdated>(app.nats, Subjects.RefactorSuggestionsUpdated, async (event) => {
    app.memoryEvents.emit(`repo:${event.repoId}`, {
      repoId: event.repoId,
      kind: "refactors",
      at: event.refreshedAt,
      total: event.total,
      topSuggestionId: event.topSuggestionId ?? null,
    });
    app.memoryEvents.emit("fleet", {
      repoId: event.repoId,
      kind: "refactors",
      at: event.refreshedAt,
      total: event.total,
      topSuggestionId: event.topSuggestionId ?? null,
    });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    ts: new Date().toISOString(),
  }));

  await registerRepoRoutes(app);
  await registerActivityRoutes(app);
  await registerOverviewRoutes(app);
  await registerCommitRoutes(app);
  await registerComponentRoutes(app);
  await registerEntropyRoutes(app);
  await registerMemoryRoutes(app);
  await registerAlertRoutes(app);
  await registerRefactorRoutes(app);
  await registerSearchRoutes(app);
  await registerSimilarityRoutes(app);
  await registerGateRoutes(app);
  await registerTelemetryRoutes(app);

  app.addHook("onClose", async () => {
    await app.db.end();
    await app.nats.drain();
    await app.neo4j.close();
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  const port = Number(process.env.API_PORT ?? "8080");
  await app.listen({ port, host: "0.0.0.0" });
  logger.info("api started", { port });
}

void main().catch((error) => {
  logger.error("api crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
