"use client";

import Link from "next/link";
import { startTransition, useEffect, useMemo, useState } from "react";
import { getOverview, openOverviewStream, type OverviewData } from "../lib/api";

function severityTone(severity: string | null | undefined): string {
  if (severity === "error") return "status-error";
  if (severity === "warn") return "status-warn";
  return "status-healthy";
}

function healthLabel(severity: string | null | undefined): string {
  if (severity === "error") return "critical";
  if (severity === "warn") return "warning";
  return "quiet";
}

export function SurfaceLaunchpad(props: {
  initialOverview: OverviewData;
}) {
  const [overview, setOverview] = useState(props.initialOverview);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    let queued = false;

    const refresh = async () => {
      setRefreshing(true);
      const next = await getOverview();
      if (!active) {
        return;
      }

      startTransition(() => {
        setOverview(next);
      });
      setRefreshing(false);
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

    const stream = openOverviewStream({
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

  const rankedSurfaces = useMemo(() => (
    [...overview.repos].sort((left, right) => (
      (right.latestSeverity === "error" ? 100 : right.latestSeverity === "warn" ? 60 : 20)
      + Number(right.pressureIndex ?? 0)
      + Number(right.entropyIndex ?? 0) * 0.35
      + right.alertCount * 6
      + Number(right.activity24h ?? 0) * 0.4
    ) - (
      (left.latestSeverity === "error" ? 100 : left.latestSeverity === "warn" ? 60 : 20)
      + Number(left.pressureIndex ?? 0)
      + Number(left.entropyIndex ?? 0) * 0.35
      + left.alertCount * 6
      + Number(left.activity24h ?? 0) * 0.4
    ))
  ), [overview.repos]);

  const attentionSurfaces = rankedSurfaces.slice(0, 6);
  const activeSurfaces = overview.repos.filter((repo) => repo.watchEnabled && repo.watchState === "active");
  const idleSurfaces = activeSurfaces.filter((repo) => Number(repo.activity24h ?? 0) === 0);
  const criticalSurfaces = overview.repos.filter((repo) => repo.latestSeverity === "error");
  const recentSurfaceRows = Array.from(
    overview.recentActivity.reduce((acc, item) => {
      if (!item.repoId || acc.has(item.repoId)) {
        return acc;
      }

      acc.set(item.repoId, item);
      return acc;
    }, new Map<string, OverviewData["recentActivity"][number]>()),
  )
    .map(([, item]) => item)
    .slice(0, 6);

  return (
    <main className="command-main launchpad-main">
      <section className="workspace-header">
        <div className="workspace-header-body">
          <div className="workspace-header-copy">
          <div className="eyebrow">Surface Home</div>
          <h1>Pick the repo you need to act on.</h1>
          <p>
            DriftCube is repo-first now. Use this page to jump straight into a surface, use the
            surface manager to add or control repos, and keep fleet-wide comparisons in their own view.
          </p>
          <div className="workspace-header-meta">
            <div className="live-indicator">
              <span className="live-dot" />
              {refreshing ? "syncing" : "live"}
            </div>
            <div className="live-generated">last frame {new Date(overview.generatedAt).toLocaleTimeString()}</div>
          </div>
          <div className="pill-row">
            <Link href="/repos" className="pill pill-cta">Manage Surfaces</Link>
            <Link href="/fleet" className="pill">Fleet Intelligence</Link>
            <Link href="/alerts" className="pill">Global Alerts</Link>
          </div>
        </div>

          <div className="workspace-header-side">
            <div className="metric-strip metric-strip-dense">
              <div className="metric-tile">
                <span>active</span>
                <strong>{activeSurfaces.length}</strong>
              </div>
              <div className="metric-tile">
                <span>critical</span>
                <strong>{criticalSurfaces.length}</strong>
              </div>
              <div className="metric-tile">
                <span>idle</span>
                <strong>{idleSurfaces.length}</strong>
              </div>
            </div>
            <div className="metric-tile">
              <span>alerts 24h</span>
              <strong>{overview.stats.alerts24h}</strong>
              <p className="muted">Jump to a surface first. Fleet views are for comparison, not primary triage.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="metric-strip">
        <div className="metric-tile">
          <span>Active Surfaces</span>
          <strong>{activeSurfaces.length}</strong>
        </div>
        <div className="metric-tile">
          <span>Need Attention</span>
          <strong>{attentionSurfaces.filter((repo) => repo.latestSeverity || Number(repo.pressureIndex ?? 0) > 40).length}</strong>
        </div>
        <div className="metric-tile">
          <span>Coverage</span>
          <strong>{Number(overview.stats.avgCoverage ?? 0).toFixed(0)}%</strong>
        </div>
        <div className="metric-tile">
          <span>Idle</span>
          <strong>{idleSurfaces.length}</strong>
        </div>
      </section>

      <section className="workspace-grid">
        <section className="panel launchpad-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Priority Queue</div>
              <h2 className="panel-title">Go Straight To Surface</h2>
            </div>
            <div className="pill">{attentionSurfaces.length} shown</div>
          </div>
          <div className="dense-list">
            {attentionSurfaces.map((repo) => (
              <Link href={`/repos/${encodeURIComponent(repo.repoId)}`} key={repo.repoId} className="dense-row dense-row-link">
                <div className="dense-row-head">
                  <strong>{repo.name}</strong>
                  <span className={`status-chip ${severityTone(repo.latestSeverity)}`}>{healthLabel(repo.latestSeverity)}</span>
                </div>
                <div className="dense-row-main">
                  pressure {Number(repo.pressureIndex ?? 0).toFixed(1)} · entropy {Number(repo.entropyIndex ?? 0).toFixed(1)} · coverage {Number(repo.analysisCoveragePercent ?? 0).toFixed(0)}%
                </div>
                <div className="dense-row-meta">
                  <span>{repo.watchState ?? "unknown"}</span>
                  <span>{repo.alertCount} alerts</span>
                </div>
                <div className="repo-visual-meter">
                  <span className={severityTone(repo.latestSeverity)} style={{ width: `${Math.min(100, Number(repo.pressureIndex ?? 0) || 12)}%` }} />
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="panel launchpad-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Recent Motion</div>
              <h2 className="panel-title">Recently Active Surfaces</h2>
            </div>
            <div className="pill">{recentSurfaceRows.length} surfaces</div>
          </div>
          <div className="dense-list">
            {recentSurfaceRows.length === 0 ? <p className="muted">No recent activity has landed yet.</p> : null}
            {recentSurfaceRows.map((item) => (
              <Link href={`/repos/${encodeURIComponent(item.repoId)}`} key={`${item.repoId}-${item.eventId}`} className="dense-row dense-row-link">
                <div className="dense-row-head">
                  <strong>{item.repoName ?? item.repoId}</strong>
                  <span className={`status-chip ${severityTone(item.alertCount > 0 ? "error" : item.parserStatus === "unsupported" ? "warn" : "healthy")}`}>
                    {item.alertCount > 0 ? "alerted" : item.parserStatus}
                  </span>
                </div>
                <div className="dense-row-main">{item.filePath}</div>
                <div className="dense-row-meta">
                  <span>{item.parserStatus}</span>
                  <span>{new Date(item.at).toLocaleTimeString()}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </section>

      <section className="panel launchpad-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Operator Note</div>
            <h2 className="panel-title">Why A Surface Can Show No Alerts</h2>
          </div>
        </div>
        <div className="launchpad-note-grid">
          <div className="memory-delta-card">
            <span>watched but idle</span>
            <strong>no file events yet</strong>
          </div>
          <div className="memory-delta-card">
            <span>watched only</span>
            <strong>unsupported file types</strong>
          </div>
          <div className="memory-delta-card">
            <span>analyzed</span>
            <strong>below alert threshold</strong>
          </div>
          <div className="memory-delta-card">
            <span>needs action</span>
            <strong>open the repo surface</strong>
          </div>
        </div>
      </section>
    </main>
  );
}
