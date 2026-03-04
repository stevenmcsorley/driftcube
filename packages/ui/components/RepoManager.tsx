"use client";

import Link from "next/link";
import { startTransition, useEffect, useState } from "react";
import { archiveRepo, deleteRepo, getRepos, openRepoManagerStream, restoreRepo, type RepoSummary, updateRepo } from "../lib/api";
import { RepoCreateForm } from "./RepoCreateForm";

function watchTone(state: string | null | undefined): string {
  if (state === "active") return "status-healthy";
  if (state === "blocked") return "status-error";
  return "status-warn";
}

function coverageTone(coverage: number): string {
  if (coverage >= 75) return "status-healthy";
  if (coverage >= 40) return "status-warn";
  return "status-error";
}

export function RepoManager(props: {
  initialRepos: RepoSummary[];
}) {
  const [repos, setRepos] = useState(props.initialRepos);
  const [busyRepoId, setBusyRepoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let queued = false;

    const refresh = async () => {
      const next = await getRepos({ includeArchived: true });
      if (!active) {
        return;
      }

      startTransition(() => {
        setRepos(next);
      });
    };

    const queueRefresh = () => {
      if (queued) {
        return;
      }

      queued = true;
      window.setTimeout(() => {
        queued = false;
        void refresh();
      }, 120);
    };

    const stream = openRepoManagerStream({
      onRefresh: () => {
        queueRefresh();
      },
    });
    const interval = window.setInterval(refresh, 45000);
    return () => {
      active = false;
      stream?.close();
      window.clearInterval(interval);
    };
  }, []);

  function handleCreated(repo: RepoSummary) {
    setRepos((current) => [repo, ...current.filter((item) => item.repoId !== repo.repoId)]);
  }

  async function handleToggle(repo: RepoSummary) {
    setBusyRepoId(repo.repoId);
    setError(null);

    try {
      const next = await updateRepo(repo.repoId, {
        watchEnabled: !(repo.watchEnabled ?? true),
      });

      setRepos((current) => current.map((item) => (item.repoId === repo.repoId ? next : item)));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Unable to update surface state.");
    } finally {
      setBusyRepoId(null);
    }
  }

  async function handleArchive(repo: RepoSummary) {
    const confirmed = window.confirm(`Archive surface "${repo.name}"? It will disappear from the live fleet, but its DriftCube data will be kept.`);
    if (!confirmed) {
      return;
    }

    setBusyRepoId(repo.repoId);
    setError(null);

    try {
      const next = await archiveRepo(repo.repoId);
      setRepos((current) => current.map((item) => (item.repoId === repo.repoId ? next : item)));
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "Unable to archive surface.");
    } finally {
      setBusyRepoId(null);
    }
  }

  async function handleRestore(repo: RepoSummary) {
    setBusyRepoId(repo.repoId);
    setError(null);

    try {
      const next = await restoreRepo(repo.repoId);
      setRepos((current) => current.map((item) => (item.repoId === repo.repoId ? next : item)));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Unable to restore surface.");
    } finally {
      setBusyRepoId(null);
    }
  }

  async function handleRemove(repo: RepoSummary) {
    const typed = window.prompt(`Type the surface name to permanently delete it and purge all DriftCube data for it:\n\n${repo.name}`);
    if (typed !== repo.name) {
      if (typed !== null) {
        setError(`Surface name did not match. "${repo.name}" was not deleted.`);
      }
      return;
    }

    setBusyRepoId(repo.repoId);
    setError(null);

    try {
      await deleteRepo(repo.repoId);
      setRepos((current) => current.filter((item) => item.repoId !== repo.repoId));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove surface.");
    } finally {
      setBusyRepoId(null);
    }
  }

  const liveRepos = repos.filter((repo) => !repo.archivedAt);
  const archivedRepos = repos.filter((repo) => repo.archivedAt);

  return (
    <main className="command-main stack">
      <section className="workspace-header">
        <div className="workspace-header-body">
          <div className="workspace-header-copy">
            <div className="eyebrow">Surface Manager</div>
            <h1>Repos And Watchers</h1>
            <p>
              This is the intake and control plane. Add repos here, map local paths into Docker, and decide whether each surface is actively watched.
            </p>
          </div>

          <div className="workspace-header-side">
            <div className="metric-strip metric-strip-dense">
              <div className="metric-tile">
                <span>active</span>
                <strong>{liveRepos.filter((repo) => repo.watchState === "active").length}</strong>
              </div>
              <div className="metric-tile">
                <span>pending</span>
                <strong>{liveRepos.filter((repo) => repo.watchState === "pending").length}</strong>
              </div>
              <div className="metric-tile">
                <span>blocked</span>
                <strong>{liveRepos.filter((repo) => repo.watchState === "blocked").length}</strong>
              </div>
            </div>
            <div className="metric-tile">
              <span>inactive</span>
              <strong>{liveRepos.filter((repo) => repo.watchState === "inactive").length}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="metric-strip">
        <div className="metric-tile">
          <span>Surfaces</span>
          <strong>{liveRepos.length}</strong>
        </div>
        <div className="metric-tile">
          <span>Active</span>
          <strong>{liveRepos.filter((repo) => repo.watchState === "active").length}</strong>
        </div>
        <div className="metric-tile">
          <span>Coverage Avg</span>
          <strong>
            {liveRepos.length === 0
              ? "0%"
              : `${Math.round(liveRepos.reduce((sum, repo) => sum + Number(repo.analysisCoveragePercent ?? 0), 0) / liveRepos.length)}%`}
          </strong>
        </div>
        <div className="metric-tile">
          <span>Watched Only</span>
          <strong>{liveRepos.reduce((sum, repo) => sum + Number(repo.unsupportedEvents24h ?? 0), 0)}</strong>
        </div>
        <div className="metric-tile">
          <span>Archived</span>
          <strong>{archivedRepos.length}</strong>
        </div>
      </section>

      <section className="workspace-grid">
        <RepoCreateForm onCreated={handleCreated} />

        <div className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">How It Works</div>
              <h2 className="panel-title">Online Vs Local Repos</h2>
            </div>
          </div>
          <div className="stack">
            <div className="intake-note">
              Local repos are watched live from inside Docker using the mapped container path.
            </div>
            <div className="intake-note">
              Remote repos should be cloned or pulled into a managed checkout volume, then analyzed like a local surface. Static analysis at this level needs real files, not just GitHub HTML.
            </div>
            <div className="intake-note">
              In the current build, remote surfaces are stored but not yet cloned automatically. Local surfaces can be activated immediately.
            </div>
          </div>
        </div>
      </section>

      {error ? <div className="form-state form-error">{error}</div> : null}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Surface Directory</div>
            <h2 className="panel-title">Managed Repos</h2>
          </div>
        </div>

          <div className="dense-list">
          {liveRepos.length === 0 ? <p className="muted">No live surfaces registered yet.</p> : null}
          {liveRepos.map((repo) => (
            <div key={repo.repoId} className="dense-row repo-manager-row">
              <div className="dense-row-head">
                <strong>{repo.name}</strong>
                <div className={`status-chip ${watchTone(repo.watchState)}`}>{repo.watchState ?? "pending"}</div>
              </div>
              <div className="dense-row-meta">
                <span>{Number(repo.analysisCoveragePercent ?? 0).toFixed(0)}% coverage</span>
                <span>{repo.activity24h ?? 0} events</span>
              </div>
              <div className="dense-row-main">{repo.hostPath ?? "n/a"}</div>
              <div className="dense-row-meta">
                <span>watch path</span>
                <span>{repo.rootPath ?? repo.remoteUrl ?? "pending"}</span>
              </div>

              {repo.watchError ? <div className="form-state form-error">{repo.watchError}</div> : null}

              <div className="repo-visual-meter">
                <span
                  className={coverageTone(Number(repo.analysisCoveragePercent ?? 0))}
                  style={{ width: `${Math.max(
                    repo.watchState === "active" ? 42 : repo.watchState === "blocked" ? 84 : 28,
                    Number(repo.analysisCoveragePercent ?? 0),
                  )}%` }}
                />
              </div>

              <div className="dense-row-actions repo-manager-actions">
                <button
                  className={`switch-pill${repo.watchEnabled ? " switch-pill-active" : ""}`}
                  disabled={busyRepoId === repo.repoId || repo.kind !== "local"}
                  onClick={() => void handleToggle(repo)}
                  type="button"
                >
                  {repo.kind !== "local"
                    ? "Clone Pending"
                    : busyRepoId === repo.repoId
                      ? "Updating..."
                      : repo.watchEnabled
                        ? "Pause Surface"
                        : "Activate Surface"}
                </button>
                <Link href={`/repos/${repo.repoId}`} className="switch-pill">Open Surface</Link>
                <button
                  className="switch-pill"
                  disabled={busyRepoId === repo.repoId}
                  onClick={() => void handleArchive(repo)}
                  type="button"
                >
                  {busyRepoId === repo.repoId ? "Working..." : "Archive Surface"}
                </button>
                <button
                  className="switch-pill switch-pill-danger"
                  disabled={busyRepoId === repo.repoId}
                  onClick={() => void handleRemove(repo)}
                  type="button"
                >
                  {busyRepoId === repo.repoId ? "Working..." : "Delete Data"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {archivedRepos.length > 0 ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Archived Surfaces</div>
              <h2 className="panel-title">Hidden But Recoverable</h2>
            </div>
          </div>

          <div className="dense-list">
            {archivedRepos.map((repo) => (
              <div key={repo.repoId} className="dense-row repo-manager-row">
                <div className="dense-row-head">
                  <strong>{repo.name}</strong>
                  <div className="status-chip status-warn">archived</div>
                </div>
                <div className="dense-row-meta">
                  <span>{repo.kind}</span>
                  <span>{repo.archivedAt ? new Date(repo.archivedAt).toLocaleString() : ""}</span>
                </div>
                <div className="dense-row-main">{repo.hostPath ?? repo.remoteUrl ?? repo.rootPath ?? "n/a"}</div>
                <div className="dense-row-actions repo-manager-actions">
                  <button
                    className="switch-pill"
                    disabled={busyRepoId === repo.repoId}
                    onClick={() => void handleRestore(repo)}
                    type="button"
                  >
                    {busyRepoId === repo.repoId ? "Working..." : "Restore Surface"}
                  </button>
                  <button
                    className="switch-pill switch-pill-danger"
                    disabled={busyRepoId === repo.repoId}
                    onClick={() => void handleRemove(repo)}
                    type="button"
                  >
                    {busyRepoId === repo.repoId ? "Working..." : "Delete Data"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
