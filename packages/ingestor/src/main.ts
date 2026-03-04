import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { connectNats, createLogger, publishJson, subscribeJson, Subjects, type RepoDeleted, type RepoRegistered, type RepoUpdated, type WatchState } from "@driftcube/shared";
import type { FSWatcher } from "chokidar";
import { Pool } from "pg";
import { describeGithubWebhookMode } from "./githubWebhook.js";
import { startGitPoller } from "./gitPoller.js";
import { watchLocalRepo } from "./localWatcher.js";

const logger = createLogger("ingestor");

const watchers = new Map<string, { watcher: FSWatcher; rootPath: string }>();

async function setWatchState(pool: Pool, repoId: string, state: WatchState, error?: string | null): Promise<void> {
  await pool.query(
    `
      UPDATE repos
      SET watch_state = $2,
          watch_error = $3
      WHERE repo_id = $1
    `,
    [repoId, state, error ?? null],
  );
}

async function stopLocalWatch(repoId: string, pool: Pool): Promise<void> {
  const current = watchers.get(repoId);
  if (current) {
    await current.watcher.close();
    watchers.delete(repoId);
    logger.info("watching paused", { repoId });
  }

  await setWatchState(pool, repoId, "inactive", null);
}

async function deleteLocalWatch(repoId: string): Promise<void> {
  const current = watchers.get(repoId);
  if (!current) {
    return;
  }

  await current.watcher.close();
  watchers.delete(repoId);
  logger.info("watch removed", { repoId });
}

async function ensureLocalWatch(
  repoId: string,
  repoName: string,
  rootPath: string,
  nc: Awaited<ReturnType<typeof connectNats>>,
  pool: Pool,
): Promise<void> {
  const absolute = resolve(rootPath);
  const current = watchers.get(repoId);
  if (current?.rootPath === absolute) {
    await setWatchState(pool, repoId, "active", null);
    return;
  }

  if (current) {
    await current.watcher.close();
    watchers.delete(repoId);
  }

  try {
    await access(absolute);
  } catch {
    await setWatchState(pool, repoId, "blocked", `Path is not accessible inside the ingestor container: ${absolute}`);
    logger.warn("local repository path is not accessible to ingestor", {
      repoId,
      rootPath: absolute,
    });
    return;
  }

  const watcher = watchLocalRepo(nc, absolute, repoId, pool);
  watchers.set(repoId, { watcher, rootPath: absolute });
  await setWatchState(pool, repoId, "active", null);
  logger.info("watching repository", { repoId, absolute, repoName });
}

async function main(): Promise<void> {
  const natsUrl = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
  const pgUrl = process.env.PG_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/driftcube";
  const watchPaths = (process.env.WATCH_PATHS ?? "").split(",").map((item) => item.trim()).filter(Boolean);

  const nc = await connectNats(natsUrl);
  const pool = new Pool({ connectionString: pgUrl });

  if (watchPaths.length === 0) {
    logger.warn("WATCH_PATHS is empty; no repositories will be monitored");
  }

  subscribeJson<RepoRegistered>(nc, Subjects.RepoRegistered, async (event) => {
    if (event.kind !== "local" || !event.rootPath) {
      return;
    }

    if (event.watchEnabled === false) {
      await stopLocalWatch(event.repoId, pool);
      return;
    }

    await ensureLocalWatch(event.repoId, event.name, event.rootPath, nc, pool);
  });

  subscribeJson<RepoUpdated>(nc, Subjects.RepoUpdated, async (event) => {
    if (event.kind && event.kind !== "local") {
      return;
    }

    if (event.watchEnabled === false) {
      await stopLocalWatch(event.repoId, pool);
      return;
    }

    if (!event.rootPath) {
      return;
    }

    await ensureLocalWatch(event.repoId, event.name ?? event.repoId, event.rootPath, nc, pool);
  });

  subscribeJson<RepoDeleted>(nc, Subjects.RepoDeleted, async (event) => {
    await deleteLocalWatch(event.repoId);
  });

  const persistedRepos = await pool.query<{
    repoId: string;
    name: string;
    rootPath: string | null;
    watchEnabled: boolean;
  }>(
    `
      SELECT repo_id AS "repoId", name, root_path AS "rootPath", watch_enabled AS "watchEnabled"
      FROM repos
      WHERE kind = 'local'
        AND root_path IS NOT NULL
        AND archived_at IS NULL
    `,
  );

  for (const repo of persistedRepos.rows) {
    if (!repo.rootPath) {
      continue;
    }

    if (!repo.watchEnabled) {
      await setWatchState(pool, repo.repoId, "inactive", null);
      continue;
    }

    await ensureLocalWatch(repo.repoId, repo.name, repo.rootPath, nc, pool);
  }

  for (const watchPath of watchPaths) {
    const absolute = resolve(watchPath);
    const repoId = basename(absolute).replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const repoRegistered: RepoRegistered = {
      schemaVersion: 1,
      repoId,
      name: basename(absolute),
      kind: "local",
      hostPath: absolute,
      rootPath: absolute,
      defaultBranch: "main",
      watchEnabled: true,
      watchState: "active",
      createdAt: new Date().toISOString(),
    };
    await ensureLocalWatch(repoId, basename(absolute), absolute, nc, pool);
    await publishJson(nc, Subjects.RepoRegistered, repoRegistered);
  }

  startGitPoller();
  describeGithubWebhookMode();
}

void main().catch((error) => {
  logger.error("ingestor crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
