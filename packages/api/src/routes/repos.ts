import { createId, publishJson, Subjects, type RepoDeleted, type RepoRegistered, type RepoUpdated, type WatchState } from "@driftcube/shared";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

const createRepoSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote"]),
  hostPath: z.string().optional(),
  rootPath: z.string().optional(),
  remoteUrl: z.string().url().optional(),
  defaultBranch: z.string().default("main"),
  watchEnabled: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (value.kind === "local" && !value.hostPath && !value.rootPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hostPath"],
      message: "Local repositories need a host path or a container path.",
    });
  }
});

const updateRepoSchema = z.object({
  name: z.string().min(1).optional(),
  hostPath: z.string().optional(),
  rootPath: z.string().optional(),
  remoteUrl: z.string().url().optional(),
  defaultBranch: z.string().min(1).optional(),
  watchEnabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one update field is required.",
});

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function translateHostPath(hostPath: string): string | undefined {
  const hostPrefix = process.env.HOST_PATH_PREFIX;
  const containerPrefix = process.env.CONTAINER_PATH_PREFIX;
  if (!hostPrefix || !containerPrefix) {
    return undefined;
  }

  const normalizedHost = normalizePath(hostPath);
  const normalizedHostPrefix = normalizePath(hostPrefix);
  const normalizedContainerPrefix = normalizePath(containerPrefix);
  if (normalizedHost !== normalizedHostPrefix && !normalizedHost.startsWith(`${normalizedHostPrefix}/`)) {
    return undefined;
  }

  const suffix = normalizedHost.slice(normalizedHostPrefix.length).replace(/^\/+/, "");
  return suffix ? `${normalizedContainerPrefix}/${suffix}` : normalizedContainerPrefix;
}

function deriveLocalPaths(input: { hostPath?: string; rootPath?: string }): { hostPath?: string; rootPath?: string } {
  const hostPath = input.hostPath ? normalizePath(input.hostPath) : undefined;
  return {
    hostPath,
    rootPath: input.rootPath
      ? normalizePath(input.rootPath)
      : hostPath
        ? translateHostPath(hostPath)
        : undefined,
  };
}

function resolveWatchState(kind: "local" | "remote", watchEnabled: boolean, rootPath?: string): WatchState {
  if (!watchEnabled) {
    return "inactive";
  }

  if (kind === "local" && rootPath) {
    return "pending";
  }

  return "inactive";
}

function resolveUpdatedWatchState(input: {
  kind: "local" | "remote";
  currentWatchEnabled: boolean;
  currentWatchState: WatchState;
  currentRootPath?: string | null;
  nextWatchEnabled: boolean;
  nextRootPath?: string | null;
}): WatchState {
  if (!input.nextWatchEnabled) {
    return "inactive";
  }

  if (input.kind === "remote") {
    if (!input.currentWatchEnabled && input.nextWatchEnabled) {
      return "pending";
    }

    return input.currentWatchState === "active" ? "active" : input.currentWatchState;
  }

  if (!input.nextRootPath) {
    return "inactive";
  }

  const currentPath = input.currentRootPath ? normalizePath(input.currentRootPath) : "";
  const nextPath = normalizePath(input.nextRootPath);
  const pathChanged = currentPath !== nextPath;

  if (!input.currentWatchEnabled && input.nextWatchEnabled) {
    return "pending";
  }

  if (pathChanged) {
    return "pending";
  }

  if (input.currentWatchState === "active" || input.currentWatchState === "blocked") {
    return input.currentWatchState;
  }

  if (input.currentWatchState === "pending") {
    return "pending";
  }

  return "pending";
}

function timeframeFrameLimit(value?: string): number {
  if (value === "6") return 6;
  if (value === "24") return 24;
  if (value === "all") return 96;
  return 12;
}

async function deleteRepoVectors(app: FastifyInstance, repoId: string): Promise<void> {
  const collections = [
    "symbols_v1",
    "diff_hunks_v1",
    "modules_v1",
    "repo_signatures_v1",
    "boundary_signatures_v1",
  ];

  for (const collection of collections) {
    try {
      await app.qdrant.delete(collection, {
        wait: true,
        filter: {
          must: [
            {
              key: "repoId",
              match: { value: repoId },
            },
          ],
        },
      });
    } catch {
      // Missing collections or empty matches are acceptable during repo teardown.
    }
  }
}

async function deleteRepoGraph(app: FastifyInstance, repoId: string): Promise<void> {
  const session = app.neo4j.session();
  try {
    await session.run(
      `
        MATCH (n {repoId: $repoId})
        DETACH DELETE n
      `,
      { repoId },
    );
    await session.run(
      `
        MATCH (p:Package)
        WHERE NOT (p)--()
        DELETE p
      `,
    );
  } finally {
    await session.close();
  }
}

async function deleteRepoRows(app: FastifyInstance, repoId: string): Promise<void> {
  const client = await app.db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM alert_refactor_links WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM alert_comments WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM file_snapshots WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM agent_telemetry WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM surface_activity WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM incidents WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM architecture_snapshots WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM refactor_suggestions WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM alerts WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM metrics WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM commits WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM gates WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM repos WHERE repo_id = $1`, [repoId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerRepoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/events", async (request, reply) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "*";

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": origin,
      vary: "Origin",
    });

    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

    const listener = (payload: Record<string, unknown>) => {
      reply.raw.write(`event: repos.refresh\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    }, 15000);

    app.memoryEvents.on("fleet", listener);
    app.memoryEvents.on("surfaces", listener);

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      app.memoryEvents.off("fleet", listener);
      app.memoryEvents.off("surfaces", listener);
      reply.raw.end();
    });
  });

  app.get("/repos", async (request) => {
    const query = z.object({
      includeArchived: z.coerce.boolean().default(false),
    }).parse(request.query);
    const result = await app.db.query(
      `
        SELECT
          r.repo_id AS "repoId",
          r.name,
          r.kind,
          r.host_path AS "hostPath",
          r.root_path AS "rootPath",
          r.remote_url AS "remoteUrl",
          r.default_branch AS "defaultBranch",
          r.watch_enabled AS "watchEnabled",
          r.watch_state AS "watchState",
          r.watch_error AS "watchError",
          latest_entropy.value AS "entropyIndex",
          latest_pressure.value AS "pressureIndex",
          COALESCE(activity_coverage.activity_24h, 0) AS "activity24h",
          COALESCE(activity_coverage.analyzable_events, 0) AS "analyzableEvents24h",
          COALESCE(activity_coverage.analyzed_events, 0) AS "analyzedEvents24h",
          COALESCE(activity_coverage.unsupported_events, 0) AS "unsupportedEvents24h",
          COALESCE(activity_coverage.coverage_percent, 0) AS "analysisCoveragePercent",
          r.archived_at AS "archivedAt",
          r.created_at AS "createdAt"
        FROM repos r
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, value
          FROM metrics
          WHERE scope = 'repo'
            AND key = 'code_entropy_index'
          ORDER BY repo_id, at DESC
        ) latest_entropy
          ON latest_entropy.repo_id = r.repo_id
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, value
          FROM metrics
          WHERE scope = 'repo'
            AND key = 'pressure_index'
          ORDER BY repo_id, at DESC
        ) latest_pressure
          ON latest_pressure.repo_id = r.repo_id
        LEFT JOIN (
          SELECT
            repo_id,
            COUNT(*)::int AS activity_24h,
            COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::int AS analyzable_events,
            COUNT(*) FILTER (WHERE parser_status = 'analyzed')::int AS analyzed_events,
            COUNT(*) FILTER (WHERE parser_status = 'unsupported')::int AS unsupported_events,
            ROUND(
              (
                COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::numeric
                / NULLIF(COUNT(*), 0)
              ) * 100,
              1
            ) AS coverage_percent
          FROM surface_activity
          WHERE at >= NOW() - INTERVAL '24 hours'
          GROUP BY repo_id
        ) activity_coverage
          ON activity_coverage.repo_id = r.repo_id
        WHERE ($1::boolean = TRUE OR r.archived_at IS NULL)
        ORDER BY r.created_at DESC
      `,
      [query.includeArchived],
    );
    return result.rows;
  });

  app.get("/repos/:repoId", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const result = await app.db.query(
      `
        SELECT
          r.repo_id AS "repoId",
          r.name,
          r.kind,
          r.host_path AS "hostPath",
          r.root_path AS "rootPath",
          r.remote_url AS "remoteUrl",
          r.default_branch AS "defaultBranch",
          r.watch_enabled AS "watchEnabled",
          r.watch_state AS "watchState",
          r.watch_error AS "watchError",
          latest_entropy.value AS "entropyIndex",
          latest_pressure.value AS "pressureIndex",
          COALESCE(activity_coverage.activity_24h, 0) AS "activity24h",
          COALESCE(activity_coverage.analyzable_events, 0) AS "analyzableEvents24h",
          COALESCE(activity_coverage.analyzed_events, 0) AS "analyzedEvents24h",
          COALESCE(activity_coverage.unsupported_events, 0) AS "unsupportedEvents24h",
          COALESCE(activity_coverage.coverage_percent, 0) AS "analysisCoveragePercent",
          r.archived_at AS "archivedAt",
          r.created_at AS "createdAt"
        FROM repos r
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, value
          FROM metrics
          WHERE scope = 'repo'
            AND key = 'code_entropy_index'
          ORDER BY repo_id, at DESC
        ) latest_entropy
          ON latest_entropy.repo_id = r.repo_id
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, value
          FROM metrics
          WHERE scope = 'repo'
            AND key = 'pressure_index'
          ORDER BY repo_id, at DESC
        ) latest_pressure
          ON latest_pressure.repo_id = r.repo_id
        LEFT JOIN (
          SELECT
            repo_id,
            COUNT(*)::int AS activity_24h,
            COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::int AS analyzable_events,
            COUNT(*) FILTER (WHERE parser_status = 'analyzed')::int AS analyzed_events,
            COUNT(*) FILTER (WHERE parser_status = 'unsupported')::int AS unsupported_events,
            ROUND(
              (
                COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::numeric
                / NULLIF(COUNT(*), 0)
              ) * 100,
              1
            ) AS coverage_percent
          FROM surface_activity
          WHERE at >= NOW() - INTERVAL '24 hours'
          GROUP BY repo_id
        ) activity_coverage
          ON activity_coverage.repo_id = r.repo_id
        WHERE r.repo_id = $1
      `,
      [params.repoId],
    );

    if (result.rowCount === 0) {
      await reply.code(404).send({ error: "repo not found" });
      return;
    }

    return result.rows[0];
  });

  app.get("/repos/:repoId/report", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const query = z.object({
      timeframe: z.enum(["6", "12", "24", "all"]).default("12"),
    }).parse(request.query);
    const frameLimit = timeframeFrameLimit(query.timeframe);

    const repoResult = await app.db.query(
      `
        SELECT
          r.repo_id AS "repoId",
          r.name,
          r.kind,
          r.watch_state AS "watchState",
          latest_entropy.value AS "entropyIndex",
          latest_pressure.value AS "pressureIndex",
          COALESCE(activity_coverage.activity_24h, 0) AS "activity24h",
          COALESCE(activity_coverage.coverage_percent, 0) AS "analysisCoveragePercent"
        FROM repos r
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, value
          FROM metrics
          WHERE scope = 'repo'
            AND key = 'code_entropy_index'
          ORDER BY repo_id, at DESC
        ) latest_entropy
          ON latest_entropy.repo_id = r.repo_id
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, value
          FROM metrics
          WHERE scope = 'repo'
            AND key = 'pressure_index'
          ORDER BY repo_id, at DESC
        ) latest_pressure
          ON latest_pressure.repo_id = r.repo_id
        LEFT JOIN (
          SELECT
            repo_id,
            COUNT(*)::int AS activity_24h,
            ROUND(
              (
                COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::numeric
                / NULLIF(COUNT(*), 0)
              ) * 100,
              1
            ) AS coverage_percent
          FROM surface_activity
          WHERE at >= NOW() - INTERVAL '24 hours'
          GROUP BY repo_id
        ) activity_coverage
          ON activity_coverage.repo_id = r.repo_id
        WHERE r.repo_id = $1
      `,
      [params.repoId],
    );

    if (repoResult.rowCount === 0) {
      await reply.code(404).send({ error: "repo not found" });
      return;
    }

    const [trendResult, componentResult, coverageResult, alertResult, statusResult] = await Promise.all([
      app.db.query(
        `
          SELECT
            at,
            entropy_index AS "entropyIndex",
            pressure_index AS "pressureIndex",
            arch_violations AS "archViolations",
            ai_edit_ratio AS "aiEditRatio",
            incident_count AS "incidentCount"
          FROM (
            SELECT
              at,
              signature -> 'health' ->> 'entropyIndex' AS entropy_index,
              signature -> 'health' ->> 'pressureIndex' AS pressure_index,
              signature -> 'graph' ->> 'archViolations' AS arch_violations,
              signature -> 'semantic' ->> 'aiEditRatio' AS ai_edit_ratio,
              (
                SELECT COUNT(*)::int
                FROM incidents i
                WHERE i.repo_id = architecture_snapshots.repo_id
                  AND i.opened_at <= architecture_snapshots.at
                  AND (i.closed_at IS NULL OR i.closed_at >= architecture_snapshots.at)
              ) AS incident_count
            FROM architecture_snapshots
            WHERE repo_id = $1
              AND scope = 'repo'
            ORDER BY at DESC
            LIMIT $2
          ) frames
          ORDER BY at ASC
        `,
        [params.repoId, frameLimit],
      ),
      app.db.query(
        `
          WITH latest_symbol AS (
            SELECT DISTINCT ON (subject_id, key)
              subject_id,
              key,
              value,
              tags,
              at
            FROM metrics
            WHERE repo_id = $1
              AND scope = 'symbol'
            ORDER BY subject_id, key, at DESC
          ),
          latest_module AS (
            SELECT DISTINCT ON (subject_id, key)
              subject_id,
              key,
              value,
              at
            FROM metrics
            WHERE repo_id = $1
              AND scope = 'module'
            ORDER BY subject_id, key, at DESC
          )
          SELECT
            COALESCE(s.tags ->> 'module', 'root') AS name,
            ROUND(AVG(CASE WHEN m.key = 'pressure_index' THEN m.value END)::numeric, 2) AS pressure,
            ROUND(AVG(CASE WHEN m.key = 'code_entropy_index' THEN m.value END)::numeric, 2) AS entropy,
            ROUND(AVG(CASE WHEN s.key = 'ai_risk_score' THEN s.value END)::numeric, 2) AS "aiRisk"
          FROM latest_symbol s
          LEFT JOIN latest_module m
            ON m.subject_id = COALESCE(s.tags ->> 'module', 'root')
          GROUP BY 1
          ORDER BY pressure DESC NULLS LAST, entropy DESC NULLS LAST
          LIMIT 8
        `,
        [params.repoId],
      ),
      app.db.query(
        `
          SELECT
            COALESCE(language, 'unknown') AS language,
            COUNT(*) FILTER (WHERE parser_status = 'unsupported')::int AS "watchedOnlyEvents",
            COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::int AS "fullPipelineEvents"
          FROM surface_activity
          WHERE repo_id = $1
            AND at >= NOW() - INTERVAL '24 hours'
          GROUP BY 1
          ORDER BY COUNT(*) DESC, language ASC
          LIMIT 8
        `,
        [params.repoId],
      ),
      app.db.query(
        `
          SELECT
            md5(CONCAT_WS('|', repo_id, COALESCE(sha, ''), at::text, type, title)) AS id,
            repo_id AS "repoId",
            at,
            severity,
            status,
            type,
            title,
            evidence,
            recommendation,
            sha
          FROM alerts
          WHERE repo_id = $1
          ORDER BY at DESC
          LIMIT 8
        `,
        [params.repoId],
      ),
      app.db.query(
        `
          SELECT status, COUNT(*)::int AS total
          FROM alerts
          WHERE repo_id = $1
          GROUP BY status
        `,
        [params.repoId],
      ),
    ]);

    const byStatus = Object.fromEntries(statusResult.rows.map((row) => [String(row.status ?? "open"), Number(row.total ?? 0)]));
    const repo = repoResult.rows[0] ?? {};
    const coveragePercent = Number(repo.analysisCoveragePercent ?? 0);
    const notes: string[] = [];

    if (coveragePercent < 35) {
      notes.push("Analysis coverage is low on this surface. Watched-only files may be dominating the latest frame.");
    }
    if (Number(repo.activity24h ?? 0) === 0) {
      notes.push("This surface is currently active but idle. DriftCube has not seen recent file changes.");
    }
    if (Number(repo.entropyIndex ?? 0) > 70) {
      notes.push("Entropy is elevated. Prioritize boundaries and duplication before additional AI churn lands.");
    }

    return {
      scope: "repo",
      repoId: params.repoId,
      generatedAt: new Date().toISOString(),
      timeframe: query.timeframe,
      summary: repo,
      charts: {
        trend: trendResult.rows.map((row) => ({
          ...row,
          at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
          entropyIndex: Number(row.entropyIndex ?? 0),
          pressureIndex: Number(row.pressureIndex ?? 0),
          archViolations: Number(row.archViolations ?? 0),
          aiEditRatio: Number(row.aiEditRatio ?? 0),
          incidentCount: Number(row.incidentCount ?? 0),
        })),
        modules: componentResult.rows.map((row) => ({
          name: String(row.name ?? "module"),
          pressure: Number(row.pressure ?? 0),
          entropy: Number(row.entropy ?? 0),
          aiRisk: Number(row.aiRisk ?? 0),
        })),
        coverage: coverageResult.rows.map((row) => ({
          language: String(row.language ?? "unknown"),
          watchedOnlyEvents: Number(row.watchedOnlyEvents ?? 0),
          fullPipelineEvents: Number(row.fullPipelineEvents ?? 0),
        })),
      },
      alerts: {
        total: alertResult.rowCount ?? 0,
        byStatus,
        top: alertResult.rows.map((row) => ({
          ...row,
          at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
        })),
      },
      notes,
    };
  });

  app.post("/repos", async (request, reply) => {
    const body = createRepoSchema.parse(request.body);
    const repoId = createId("repo");
    const localPaths = body.kind === "local" ? deriveLocalPaths(body) : {};
    const watchState = resolveWatchState(body.kind, body.watchEnabled, localPaths.rootPath);
    const payload: RepoRegistered = {
      schemaVersion: 1,
      repoId,
      name: body.name,
      kind: body.kind,
      hostPath: localPaths.hostPath,
      rootPath: localPaths.rootPath,
      remoteUrl: body.remoteUrl,
      defaultBranch: body.defaultBranch,
      watchEnabled: body.watchEnabled,
      watchState,
      createdAt: new Date().toISOString(),
    };

    await app.db.query(
      `
        INSERT INTO repos (repo_id, name, kind, host_path, root_path, remote_url, default_branch, watch_enabled, watch_state, watch_error, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        payload.repoId,
        payload.name,
        payload.kind,
        payload.hostPath ?? null,
        payload.rootPath ?? null,
        payload.remoteUrl ?? null,
        payload.defaultBranch,
        payload.watchEnabled ?? true,
        payload.watchState ?? "pending",
        payload.watchError ?? null,
        payload.createdAt,
      ],
    );

    await publishJson(app.nats, Subjects.RepoRegistered, payload);
    app.memoryEvents.emit("surfaces", {
      kind: "repo",
      repoId: payload.repoId,
      at: new Date().toISOString(),
    });
    await reply.code(201).send(payload);
  });

  app.patch("/repos/:repoId", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const body = updateRepoSchema.parse(request.body);

    const current = await app.db.query<{
      repoId: string;
      name: string;
      kind: "local" | "remote";
      hostPath: string | null;
      rootPath: string | null;
      remoteUrl: string | null;
      defaultBranch: string;
      watchEnabled: boolean;
      watchState: WatchState;
      createdAt: string;
    }>(
      `
        SELECT repo_id AS "repoId", name, kind, host_path AS "hostPath", root_path AS "rootPath",
               remote_url AS "remoteUrl", default_branch AS "defaultBranch", watch_enabled AS "watchEnabled",
               watch_state AS "watchState",
               created_at AS "createdAt"
        FROM repos
        WHERE repo_id = $1
      `,
      [params.repoId],
    );

    if (current.rowCount === 0) {
      await reply.code(404).send({ error: "repo not found" });
      return;
    }

    const existing = current.rows[0];
    if (!existing) {
      await reply.code(404).send({ error: "repo not found" });
      return;
    }
    const localPaths = existing.kind === "local"
      ? deriveLocalPaths({
        hostPath: body.hostPath ?? existing.hostPath ?? undefined,
        rootPath: body.rootPath ?? existing.rootPath ?? undefined,
      })
      : {};
    const watchEnabled = body.watchEnabled ?? existing.watchEnabled;
    const watchState = resolveUpdatedWatchState({
      kind: existing.kind,
      currentWatchEnabled: existing.watchEnabled,
      currentWatchState: existing.watchState,
      currentRootPath: existing.rootPath,
      nextWatchEnabled: watchEnabled,
      nextRootPath: existing.kind === "local" ? localPaths.rootPath : existing.rootPath,
    });

    if (existing.kind === "local" && watchEnabled && !localPaths.rootPath) {
      await reply.code(400).send({ error: "Local repositories need a Docker-visible watch path." });
      return;
    }

    const result = await app.db.query(
      `
        UPDATE repos
        SET name = $2,
            host_path = $3,
            root_path = $4,
            remote_url = $5,
            default_branch = $6,
            watch_enabled = $7,
            watch_state = $8,
            watch_error = CASE WHEN $8 IN ('pending', 'active', 'inactive') THEN NULL ELSE watch_error END
        WHERE repo_id = $1
        RETURNING repo_id AS "repoId", name, kind, host_path AS "hostPath", root_path AS "rootPath",
                  remote_url AS "remoteUrl", default_branch AS "defaultBranch", watch_enabled AS "watchEnabled",
                  watch_state AS "watchState", watch_error AS "watchError", created_at AS "createdAt"
      `,
      [
        params.repoId,
        body.name ?? existing.name,
        existing.kind === "local" ? localPaths.hostPath ?? null : null,
        existing.kind === "local" ? localPaths.rootPath ?? null : existing.rootPath,
        existing.kind === "remote" ? body.remoteUrl ?? existing.remoteUrl : existing.remoteUrl,
        body.defaultBranch ?? existing.defaultBranch,
        watchEnabled,
        watchState,
      ],
    );

    const event: RepoUpdated = {
      schemaVersion: 1,
      repoId: params.repoId,
      name: body.name ?? existing.name,
      kind: existing.kind,
      hostPath: existing.kind === "local" ? localPaths.hostPath : undefined,
      rootPath: existing.kind === "local" ? localPaths.rootPath : undefined,
      remoteUrl: existing.kind === "remote" ? body.remoteUrl ?? existing.remoteUrl ?? undefined : undefined,
      defaultBranch: body.defaultBranch ?? existing.defaultBranch,
      watchEnabled,
      watchState,
      updatedAt: new Date().toISOString(),
    };

    await publishJson(app.nats, Subjects.RepoUpdated, event);
    app.memoryEvents.emit("surfaces", {
      kind: "repo",
      repoId: params.repoId,
      at: new Date().toISOString(),
      watchEnabled,
      watchState,
    });
    return result.rows[0];
  });

  app.post("/repos/:repoId/archive", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const current = await app.db.query<{
      repoId: string;
      name: string;
      kind: "local" | "remote";
      hostPath: string | null;
      rootPath: string | null;
      remoteUrl: string | null;
      defaultBranch: string;
      watchEnabled: boolean;
      archivedAt: string | null;
      createdAt: string;
    }>(
      `
        SELECT repo_id AS "repoId", name, kind, host_path AS "hostPath", root_path AS "rootPath",
               remote_url AS "remoteUrl", default_branch AS "defaultBranch", watch_enabled AS "watchEnabled",
               archived_at AS "archivedAt", created_at AS "createdAt"
        FROM repos
        WHERE repo_id = $1
      `,
      [params.repoId],
    );

    const existing = current.rows[0];
    if (!existing) {
      await reply.code(404).send({ error: "repo not found" });
      return;
    }

    const archivedAt = new Date().toISOString();
    const result = await app.db.query(
      `
        UPDATE repos
        SET archived_at = $2,
            watch_state = 'inactive',
            watch_error = NULL
        WHERE repo_id = $1
        RETURNING repo_id AS "repoId", name, kind, host_path AS "hostPath", root_path AS "rootPath",
                  remote_url AS "remoteUrl", default_branch AS "defaultBranch", watch_enabled AS "watchEnabled",
                  watch_state AS "watchState", watch_error AS "watchError", archived_at AS "archivedAt",
                  created_at AS "createdAt"
      `,
      [params.repoId, archivedAt],
    );

    const event: RepoUpdated = {
      schemaVersion: 1,
      repoId: params.repoId,
      name: existing.name,
      kind: existing.kind,
      hostPath: existing.hostPath ?? undefined,
      rootPath: existing.rootPath ?? undefined,
      remoteUrl: existing.remoteUrl ?? undefined,
      defaultBranch: existing.defaultBranch,
      watchEnabled: false,
      watchState: "inactive",
      updatedAt: archivedAt,
    };

    await publishJson(app.nats, Subjects.RepoUpdated, event);
    app.memoryEvents.emit("surfaces", {
      kind: "repo-archived",
      repoId: params.repoId,
      at: archivedAt,
    });
    app.memoryEvents.emit("fleet", {
      kind: "repo-archived",
      repoId: params.repoId,
      at: archivedAt,
    });

    return result.rows[0];
  });

  app.post("/repos/:repoId/restore", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const current = await app.db.query<{
      repoId: string;
      name: string;
      kind: "local" | "remote";
      hostPath: string | null;
      rootPath: string | null;
      remoteUrl: string | null;
      defaultBranch: string;
      watchEnabled: boolean;
      archivedAt: string | null;
      createdAt: string;
    }>(
      `
        SELECT repo_id AS "repoId", name, kind, host_path AS "hostPath", root_path AS "rootPath",
               remote_url AS "remoteUrl", default_branch AS "defaultBranch", watch_enabled AS "watchEnabled",
               archived_at AS "archivedAt", created_at AS "createdAt"
        FROM repos
        WHERE repo_id = $1
      `,
      [params.repoId],
    );

    const existing = current.rows[0];
    if (!existing) {
      await reply.code(404).send({ error: "repo not found" });
      return;
    }

    const watchState = resolveWatchState(existing.kind, existing.watchEnabled, existing.rootPath ?? undefined);
    const updatedAt = new Date().toISOString();
    const result = await app.db.query(
      `
        UPDATE repos
        SET archived_at = NULL,
            watch_state = $2,
            watch_error = NULL
        WHERE repo_id = $1
        RETURNING repo_id AS "repoId", name, kind, host_path AS "hostPath", root_path AS "rootPath",
                  remote_url AS "remoteUrl", default_branch AS "defaultBranch", watch_enabled AS "watchEnabled",
                  watch_state AS "watchState", watch_error AS "watchError", archived_at AS "archivedAt",
                  created_at AS "createdAt"
      `,
      [params.repoId, watchState],
    );

    const event: RepoUpdated = {
      schemaVersion: 1,
      repoId: params.repoId,
      name: existing.name,
      kind: existing.kind,
      hostPath: existing.hostPath ?? undefined,
      rootPath: existing.rootPath ?? undefined,
      remoteUrl: existing.remoteUrl ?? undefined,
      defaultBranch: existing.defaultBranch,
      watchEnabled: existing.watchEnabled,
      watchState,
      updatedAt,
    };

    await publishJson(app.nats, Subjects.RepoUpdated, event);
    app.memoryEvents.emit("surfaces", {
      kind: "repo-restored",
      repoId: params.repoId,
      at: updatedAt,
    });
    app.memoryEvents.emit("fleet", {
      kind: "repo-restored",
      repoId: params.repoId,
      at: updatedAt,
    });

    return result.rows[0];
  });

  app.delete("/repos/:repoId", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const current = await app.db.query<{
      repoId: string;
      name: string;
      kind: "local" | "remote";
    }>(
      `
        SELECT repo_id AS "repoId", name, kind
        FROM repos
        WHERE repo_id = $1
      `,
      [params.repoId],
    );

    if (current.rowCount === 0) {
      await reply.code(404).send({ error: "repo not found" });
      return;
    }

    const existing = current.rows[0];
    const event: RepoDeleted = {
      schemaVersion: 1,
      repoId: params.repoId,
      name: existing?.name,
      kind: existing?.kind,
      deletedAt: new Date().toISOString(),
    };

    await publishJson(app.nats, Subjects.RepoDeleted, event);
    await Promise.all([
      deleteRepoVectors(app, params.repoId),
      deleteRepoGraph(app, params.repoId),
    ]);
    await deleteRepoRows(app, params.repoId);

    app.memoryEvents.emit("surfaces", {
      kind: "repo-deleted",
      repoId: params.repoId,
      at: event.deletedAt,
    });
    app.memoryEvents.emit("fleet", {
      kind: "repo-deleted",
      repoId: params.repoId,
      at: event.deletedAt,
    });

    await reply.send({
      ok: true,
      repoId: params.repoId,
      deletedAt: event.deletedAt,
    });
  });
}
