"use client";

import Link from "next/link";
import { startTransition, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getOverview, openOverviewStream, type OverviewData, type RepoSummary } from "../lib/api";
import { RepoCreateForm } from "./RepoCreateForm";

function severityTone(severity: string | null | undefined): string {
  if (severity === "error") return "status-error";
  if (severity === "warn") return "status-warn";
  return "status-healthy";
}

function severityWeight(severity: string | null | undefined): number {
  if (severity === "error") return 100;
  if (severity === "warn") return 58;
  return 18;
}

function activityTone(status: string, alertCount: number): string {
  if (alertCount > 0) return "status-error";
  if (status === "analyzed") return "status-healthy";
  return "status-warn";
}

function activityReason(status: string, alertCount: number): { label: string; tone: string } {
  if (alertCount > 0) {
    return {
      label: status === "unsupported" ? "heuristic fired" : "drift rule hit",
      tone: "status-error",
    };
  }

  if (status === "unsupported") {
    return {
      label: "watched-only lane",
      tone: "status-warn",
    };
  }

  if (status === "no_symbols") {
    return {
      label: "parsed no symbols",
      tone: "status-warn",
    };
  }

  if (status === "pending") {
    return {
      label: "awaiting parser",
      tone: "status-warn",
    };
  }

  return {
    label: "below alert threshold",
    tone: "status-healthy",
  };
}

function coverageTone(coverage: number): string {
  if (coverage >= 75) return "status-healthy";
  if (coverage >= 40) return "status-warn";
  return "status-error";
}

function coveragePanelTone(coverage: number): string {
  if (coverage >= 75) return "status-panel-healthy";
  if (coverage >= 40) return "status-panel-warn";
  return "status-panel-error";
}

function alertSignalLabel(alert: OverviewData["recentAlerts"][number]): string {
  if (alert.type === "CONTENT_HEURISTIC" && typeof alert.evidence?.heuristicCategory === "string") {
    return alert.evidence.heuristicCategory.replaceAll("_", " ");
  }

  return alert.type.replaceAll("_", " ");
}

function alertCategoryValue(alert: OverviewData["recentAlerts"][number]): string | null {
  if (alert.type !== "CONTENT_HEURISTIC") {
    return null;
  }

  return typeof alert.evidence?.heuristicCategory === "string"
    ? alert.evidence.heuristicCategory
    : "CONTENT_HEURISTIC";
}

export function HomeCommandCenter(props: {
  initialOverview: OverviewData;
}) {
  const [overview, setOverview] = useState(props.initialOverview);
  const [refreshing, setRefreshing] = useState(false);
  const [fleetActivityMode, setFleetActivityMode] = useState<"all" | "full" | "watched">("all");
  const [alertCategoryMode, setAlertCategoryMode] = useState<string>("all");
  const searchParams = useSearchParams();
  const activePattern = searchParams.get("pattern");

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

  function handleCreated(repo: RepoSummary) {
    setOverview((current) => ({
      ...current,
      stats: {
        ...current.stats,
        repoCount: current.stats.repoCount + 1,
      },
      repos: [
        {
          ...repo,
          componentCount: 0,
          latestSeverity: null,
          latestAlertAt: null,
          alertCount: 0,
        },
        ...current.repos.filter((item) => item.repoId !== repo.repoId),
      ],
      generatedAt: new Date().toISOString(),
    }));
  }

  const activePatternGroup = activePattern
    ? overview.patterns.find((pattern) => pattern.label === activePattern)
    : null;
  const filteredRepos = activePatternGroup
    ? overview.repos.filter((repo) => activePatternGroup.repos.some((item) => item.repoId === repo.repoId))
    : overview.repos;
  const alertCategories = Array.from(
    new Set(
      overview.recentAlerts
        .map((alert) => alertCategoryValue(alert))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const visibleAlerts = overview.recentAlerts.filter((alert) => (
    alertCategoryMode === "all" || alertCategoryValue(alert) === alertCategoryMode
  ));
  const topAlerts = visibleAlerts.slice(0, 6);
  const quietRepos = filteredRepos.filter((repo) => !repo.latestSeverity).length;
  const warningRepos = filteredRepos.filter((repo) => repo.latestSeverity === "warn").length;
  const criticalRepos = filteredRepos.filter((repo) => repo.latestSeverity === "error").length;
  const fleetEntropy = Number(overview.stats.avgEntropy ?? 0);
  const fleetPressure = Number(overview.stats.avgPressure ?? 0);
  const repoPressure = [...filteredRepos]
    .sort((left, right) => (
      Number(right.pressureIndex ?? 0)
      + severityWeight(right.latestSeverity) * 0.35
      + right.alertCount * 6
    ) - (
      Number(left.pressureIndex ?? 0)
      + severityWeight(left.latestSeverity) * 0.35
      + left.alertCount * 6
    ))
    .slice(0, 6);
  const signalMix = Array.from(
    overview.recentAlerts.reduce((acc, alert) => {
      const key = alertSignalLabel(alert);
      acc.set(key, (acc.get(key) ?? 0) + 1);
      return acc;
    }, new Map<string, number>()),
  )
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);
  const fleetPatterns = overview.patterns.slice(0, 4);
  const visibleRepoCount = filteredRepos.length;
  const fleetActivity = overview.recentActivity
    .filter((item) => {
      if (fleetActivityMode === "full") {
        return item.parserStatus === "analyzed" || item.parserStatus === "pending" || item.parserStatus === "no_symbols";
      }

      if (fleetActivityMode === "watched") {
        return item.parserStatus === "unsupported";
      }

      return true;
    })
    .slice(0, 10);
  const fleetCoverage = Number(overview.stats.avgCoverage ?? 0);
  const languageCoverage = overview.languageCoverage.slice(0, 8);
  const languageWatchTrends = overview.languageWatchTrends.slice(0, 5);

  return (
    <main className="command-main">
      <section className="workspace-header">
        <div className="workspace-header-body">
          <div className="workspace-header-copy">
            <div className="eyebrow">Fleet Intelligence</div>
            <h1>DriftCube</h1>
            <p>
              Fleet comparison only. Use this view for cross-repo patterns, coverage debt, and shared failure modes, then jump back into a specific surface to act.
            </p>
            <div className="workspace-header-meta">
              <div className="live-indicator">
                <span className="live-dot" />
                {refreshing ? "syncing" : "streaming"}
              </div>
              <div className="live-generated">last frame {new Date(overview.generatedAt).toLocaleTimeString()}</div>
            </div>
          </div>
          <div className="workspace-header-side">
            <div className="metric-strip metric-strip-dense">
              <div className="metric-tile">
                <span>repos</span>
                <strong>{overview.stats.repoCount}</strong>
              </div>
              <div className="metric-tile">
                <span>alerts 24h</span>
                <strong>{overview.stats.alerts24h}</strong>
              </div>
              <div className="metric-tile">
                <span>critical 24h</span>
                <strong>{overview.stats.critical24h}</strong>
              </div>
            </div>
            <div className="metric-tile">
              <span>signals 24h</span>
              <strong>{overview.stats.signals24h}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="metric-strip">
        <div className="metric-tile">
          <span>Realtime</span>
          <strong>{overview.stats.repoCount}</strong>
        </div>
        <div className="metric-tile">
          <span>Critical Drift</span>
          <strong>{overview.stats.critical24h}</strong>
        </div>
        <div className="metric-tile">
          <span>Fleet Entropy</span>
          <strong>{fleetEntropy.toFixed(1)}</strong>
        </div>
        <div className="metric-tile">
          <span>Fleet Pressure</span>
          <strong>{fleetPressure.toFixed(1)}</strong>
        </div>
        <div className="metric-tile">
          <span>Fleet Coverage</span>
          <strong>{`${fleetCoverage.toFixed(0)}%`}</strong>
        </div>
      </section>

      <section className="status-wall">
        <div className="status-panel status-panel-healthy">
          <div className="eyebrow">Quiet Surfaces</div>
          <strong>{quietRepos}</strong>
          <div className="status-meter">
            <span style={{ width: `${visibleRepoCount === 0 ? 0 : (quietRepos / visibleRepoCount) * 100}%` }} />
          </div>
        </div>
        <div className="status-panel status-panel-warn">
          <div className="eyebrow">Warning Surfaces</div>
          <strong>{warningRepos}</strong>
          <div className="status-meter">
            <span style={{ width: `${visibleRepoCount === 0 ? 0 : (warningRepos / visibleRepoCount) * 100}%` }} />
          </div>
        </div>
        <div className="status-panel status-panel-error">
          <div className="eyebrow">Critical Surfaces</div>
          <strong>{criticalRepos}</strong>
          <div className="status-meter">
            <span style={{ width: `${visibleRepoCount === 0 ? 0 : (criticalRepos / visibleRepoCount) * 100}%` }} />
          </div>
        </div>
        <div className={`status-panel ${coveragePanelTone(fleetCoverage)}`}>
          <div className="eyebrow">Coverage</div>
          <strong>{fleetCoverage.toFixed(0)}%</strong>
          <div className="status-meter">
            <span style={{ width: `${Math.min(100, fleetCoverage)}%` }} />
          </div>
        </div>
      </section>

      <section className="visual-deck">
        <div className="panel horizon-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Threat Horizon</div>
              <h2 className="panel-title">Repo Heatfield</h2>
            </div>
            <div className="pill">sorted by pressure</div>
          </div>
          <div className="pressure-ladder">
            {repoPressure.length === 0 ? <p className="muted">Waiting for repositories to come online.</p> : null}
            {repoPressure.map((repo) => (
              <Link href={`/repos/${repo.repoId}`} key={repo.repoId} className="pressure-row">
                <div className="pressure-copy">
                  <strong>{repo.name}</strong>
                  <span>pressure {Number(repo.pressureIndex ?? 0).toFixed(1)}, entropy {Number(repo.entropyIndex ?? 0).toFixed(1)}</span>
                </div>
                <div className="pressure-meter">
                  <span
                    className={severityTone(repo.latestSeverity)}
                    style={{ width: `${Math.max(
                      Number(repo.pressureIndex ?? 0),
                      severityWeight(repo.latestSeverity),
                      Math.min(100, repo.alertCount * 10),
                    )}%` }}
                  />
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="panel horizon-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Signal Constellation</div>
              <h2 className="panel-title">Alert Mix</h2>
            </div>
            <div className="pill">last 6 types</div>
          </div>
          <div className="signal-grid">
            {signalMix.length === 0 ? <p className="muted">Alert families will appear here as the live stream fills.</p> : null}
            {signalMix.map(([type, count]) => (
              <div key={type} className="signal-block">
                <span>{type}</span>
                <strong>{count}</strong>
                <div className="signal-meter">
                  <span style={{ width: `${Math.min(100, (count / Math.max(overview.recentAlerts.length, 1)) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel horizon-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Fleet Patterns</div>
              <h2 className="panel-title">Similarity Clusters</h2>
            </div>
          <div className="pill">{activePatternGroup ? `filter ${activePatternGroup.label}` : `${fleetPatterns.length} clusters`}</div>
        </div>
        <div className="memory-incident-list">
          {fleetPatterns.length === 0 ? <p className="muted">Pattern clusters appear once multiple surfaces accumulate drift memory.</p> : null}
          {activePatternGroup ? (
            <Link href="/" className="memory-incident-card">
              <div className="memory-incident-top">
                <span className="severity-badge status-healthy">clear filter</span>
                <span className="pill">{filteredRepos.length} visible</span>
              </div>
              <strong>{activePatternGroup.label}</strong>
              <p className="muted">Show the full fleet again.</p>
            </Link>
          ) : null}
          {fleetPatterns.map((pattern) => (
            <Link key={pattern.label} href={`/?pattern=${encodeURIComponent(pattern.label)}`} className="memory-incident-card">
              <div className="memory-incident-top">
                <span className="severity-badge status-warn">{pattern.label}</span>
                <span className="pill">{pattern.repoCount} surfaces</span>
              </div>
              <strong>entropy {pattern.avgEntropy.toFixed(1)} · pressure {pattern.avgPressure.toFixed(1)}</strong>
              <div className="refactor-list">
                {pattern.dominantSignals.map((signal) => (
                  <div key={`${pattern.label}-${signal}`} className="refactor-chip">{signal}</div>
                ))}
              </div>
              <div className="pill-row">
                {pattern.repos.slice(0, 4).map((repo) => (
                  <span key={`${pattern.label}-${repo.repoId}`} className="pill">
                    {repo.name}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="command-grid">
        <div className="panel marquee-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Live Wire</div>
              <h2 className="panel-title">Recent Alerts</h2>
            </div>
            <div className="pill">{alertCategoryMode === "all" ? "all categories" : alertCategoryMode.replaceAll("_", " ")}</div>
          </div>
          <div className="pill-row">
            <button
              type="button"
              className={`switch-pill${alertCategoryMode === "all" ? " switch-pill-active" : ""}`}
              onClick={() => setAlertCategoryMode("all")}
            >
              All Categories
            </button>
            {alertCategories.map((category) => (
              <button
                type="button"
                key={`home-alert-category-${category}`}
                className={`switch-pill${alertCategoryMode === category ? " switch-pill-active" : ""}`}
                onClick={() => setAlertCategoryMode(category)}
              >
                {category.replaceAll("_", " ")}
              </button>
            ))}
          </div>
          <div className="alert-marquee">
            <div className="alert-marquee-track">
              {(topAlerts.length > 0 ? [...topAlerts, ...topAlerts] : []).map((alert, index) => (
                <div className="marquee-item" key={`${alert.repoId ?? "repo"}-${alert.at}-${index}`}>
                  <span className={`severity-badge ${severityTone(alert.severity)}`}>{alertSignalLabel(alert)}</span>
                  {alertCategoryValue(alert) ? (
                    <span className="marquee-category-chip">{alertCategoryValue(alert)?.replaceAll("_", " ")}</span>
                  ) : null}
                  <span>{alert.repoId ?? "repo"}</span>
                  <span className="muted">{alert.title}</span>
                </div>
              ))}
              {topAlerts.length === 0 ? (
                <div className="muted">
                  {alertCategoryMode === "all" ? "No alerts have been emitted yet." : "No alerts match the active category."}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <RepoCreateForm onCreated={handleCreated} />
      </section>

      <section className="visual-deck">
        <div className="panel horizon-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Fleet Activity</div>
              <h2 className="panel-title">Live Surface Stream</h2>
            </div>
            <div className="pill">{overview.stats.activity24h} events / 24h</div>
          </div>
          <div className="pill-row">
            <button
              type="button"
              className={`switch-pill${fleetActivityMode === "all" ? " switch-pill-active" : ""}`}
              onClick={() => setFleetActivityMode("all")}
            >
              All Activity
            </button>
            <button
              type="button"
              className={`switch-pill${fleetActivityMode === "full" ? " switch-pill-active" : ""}`}
              onClick={() => setFleetActivityMode("full")}
            >
              Full Analysis
            </button>
            <button
              type="button"
              className={`switch-pill${fleetActivityMode === "watched" ? " switch-pill-active" : ""}`}
              onClick={() => setFleetActivityMode("watched")}
            >
              Watched Only
            </button>
          </div>
          <div className="memory-incident-list">
            {fleetActivity.length === 0 ? <p className="muted">Live file activity will appear here as surfaces change.</p> : null}
            {fleetActivity.map((item) => {
              const reason = activityReason(item.parserStatus, item.alertCount);
              return (
                <Link
                  href={`/repos/${encodeURIComponent(item.repoId)}`}
                  key={`${item.eventId}-fleet`}
                  className="memory-incident-card"
                >
                  <div className="memory-incident-top">
                    <span className={`severity-badge ${activityTone(item.parserStatus, item.alertCount)}`}>{item.parserStatus.replaceAll("_", " ")}</span>
                    <span className="pill">{item.repoName ?? item.repoId}</span>
                  </div>
                  <strong>{item.filePath}</strong>
                  <p className="muted">{item.note ?? `${item.language ?? "unknown"} ${item.changeType}`}</p>
                  <div className="pill-row">
                    <span className="pill">{item.language ?? "unknown"}</span>
                    {item.provenance && item.provenance !== "unknown" ? (
                      <span className="pill">{item.provenance}</span>
                    ) : null}
                    <span className="pill">{item.symbolCount} symbols</span>
                    <span className={`pill ${item.alertCount > 0 ? "pill-removed" : "pill-added"}`}>{item.alertCount} alerts</span>
                    <span className={`pill ${reason.tone}`}>{reason.label}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        <div className="panel horizon-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Coverage Gradient</div>
              <h2 className="panel-title">What DriftCube Can Read</h2>
            </div>
            <div className="pill">{overview.stats.watchedOnly24h} watched-only / 24h</div>
          </div>
          <div className="pressure-ladder">
            {filteredRepos.length === 0 ? <p className="muted">Coverage appears once surfaces are registered.</p> : null}
            {filteredRepos.slice(0, 8).map((repo) => {
              const coverage = Number(repo.analysisCoveragePercent ?? 0);
              const analyzed = Number(repo.analyzedEvents24h ?? 0);
              const unsupported = Number(repo.unsupportedEvents24h ?? 0);
              return (
                <Link href={`/repos/${repo.repoId}`} key={`coverage-${repo.repoId}`} className="pressure-row">
                  <div className="pressure-copy">
                    <strong>{repo.name}</strong>
                    <span>{coverage.toFixed(0)}% analyzable · {analyzed} analyzed · {unsupported} watched-only</span>
                  </div>
                  <div className="pressure-meter">
                    <span className={coverageTone(coverage)} style={{ width: `${Math.min(100, coverage)}%` }} />
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="panel horizon-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Language Coverage</div>
            <h2 className="panel-title">Watched-Only Dominance</h2>
          </div>
          <div className="pill">{languageCoverage.length} languages</div>
        </div>
        <div className="pressure-ladder">
          {languageCoverage.length === 0 ? <p className="muted">Language mix appears once activity accumulates.</p> : null}
          {languageCoverage.map((entry) => {
            const watchedOnly = Number(entry.watchedOnlyEvents ?? 0);
            const total = Number(entry.totalEvents ?? 0);
            const coverage = Number(entry.coveragePercent ?? 0);
            const watchedOnlyPercent = total === 0 ? 0 : (watchedOnly / total) * 100;

            return (
              <div key={`lang-${entry.language}`} className="pressure-row">
                <div className="pressure-copy">
                  <strong>{entry.language}</strong>
                  <span>{total} events · {watchedOnly} watched-only · {coverage.toFixed(0)}% full-pipeline</span>
                </div>
                <div className="pressure-meter">
                  <span className={watchedOnlyPercent >= 60 ? "status-error" : watchedOnlyPercent >= 30 ? "status-warn" : "status-healthy"} style={{ width: `${Math.min(100, watchedOnlyPercent)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel horizon-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Coverage Debt</div>
            <h2 className="panel-title">Watched-Only Trend</h2>
          </div>
          <div className="pill">last 24h by hour</div>
        </div>
        <div className="language-trend-grid">
          {languageWatchTrends.length === 0 ? <p className="muted">Trend lines appear once watched-only activity accumulates.</p> : null}
          {languageWatchTrends.map((entry) => {
            const peak = Math.max(1, ...entry.points.map((point) => point.watchedOnlyEvents));
            const latestPoint = entry.points[entry.points.length - 1];
            return (
              <div key={`lang-trend-${entry.language}`} className="language-trend-row">
                <div className="language-trend-copy">
                  <strong>{entry.language}</strong>
                  <span>
                    {entry.totalWatchedOnlyEvents} watched-only of {entry.totalEvents} total events
                  </span>
                </div>
                <div className="language-trend-spark">
                  {entry.points.map((point) => {
                    const height = point.watchedOnlyEvents === 0 ? 8 : Math.max(10, (point.watchedOnlyEvents / peak) * 100);
                    const toneClass = point.watchedOnlyPercent >= 60
                      ? "status-error"
                      : point.watchedOnlyPercent >= 30
                        ? "status-warn"
                        : "status-healthy";
                    return (
                      <span
                        key={`${entry.language}-${point.at}`}
                        className={`language-trend-bar ${toneClass}`}
                        style={{ height: `${height}%` }}
                        title={`${new Date(point.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${point.watchedOnlyEvents} watched-only · ${point.watchedOnlyPercent.toFixed(0)}%`}
                      />
                    );
                  })}
                </div>
                <div className="language-trend-meta">
                  <span>now {Number(latestPoint?.watchedOnlyPercent ?? 0).toFixed(0)}%</span>
                  <span>{entry.points.length} frames</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Repo Grid</div>
            <h2 className="panel-title">Observed Surfaces</h2>
          </div>
          <div className="pill">auto-refresh 5s</div>
        </div>
        <div className="repo-grid">
          {filteredRepos.length === 0 ? <p className="muted">No repositories match this fleet pattern yet.</p> : null}
          {filteredRepos.map((repo) => (
            <Link href={`/repos/${repo.repoId}`} key={repo.repoId} className="repo-card repo-card-live">
              <div className={`repo-glow ${severityTone(repo.latestSeverity)}`} />
              <div className="repo-card-top">
                <div>
                  <div className="repo-name">{repo.name}</div>
                  <div className="pill-row">
                    <span className="pill">{repo.kind}</span>
                    <span className="pill">{repo.defaultBranch}</span>
                  </div>
                </div>
                <div className={`status-chip ${severityTone(repo.latestSeverity)}`}>
                  {repo.latestSeverity ?? "quiet"}
                </div>
              </div>

              <div className="repo-metrics">
                <div>
                  <span>components</span>
                  <strong>{repo.componentCount}</strong>
                </div>
                <div>
                  <span>alerts 24h</span>
                  <strong>{repo.alertCount}</strong>
                </div>
                <div>
                  <span>entropy</span>
                  <strong>{Number(repo.entropyIndex ?? 0).toFixed(1)}</strong>
                </div>
                <div>
                  <span>pressure</span>
                  <strong>{Number(repo.pressureIndex ?? 0).toFixed(1)}</strong>
                </div>
                <div>
                  <span>coverage</span>
                  <strong>{Number(repo.analysisCoveragePercent ?? 0).toFixed(0)}%</strong>
                </div>
              </div>

              <div className="repo-visual-meter">
                <span
                  className={severityTone(repo.latestSeverity)}
                  style={{ width: `${Math.max(
                    Number(repo.pressureIndex ?? 0),
                    severityWeight(repo.latestSeverity),
                    Math.min(100, repo.alertCount * 14),
                  )}%` }}
                />
              </div>

              <div className="repo-card-footer">
                <span className="muted">{repo.rootPath ?? repo.remoteUrl ?? "monitor target pending"}</span>
                <span className="muted">
                  {repo.latestAlertAt ? `latest ${new Date(repo.latestAlertAt).toLocaleTimeString()}` : "no alert yet"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
