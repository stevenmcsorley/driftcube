"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { startTransition, useEffect, useMemo, useState } from "react";
import {
  getComponents,
  getRepo,
  getRepoActivity,
  getRepoAlertDetail,
  getRepoAlerts,
  getRepoEntropy,
  getRepoMemory,
  getRepoSurfaceReport,
  openRepoMemoryStream,
  type AlertDetail,
  type AlertPage,
  type RepoActivityItem,
  type RepoActivityPage,
  type RepoEntropyData,
  type RepoMemoryData,
  type RepoSummary,
} from "../lib/api";
import { AlertDetailDrawer } from "./AlertDetailDrawer";
import { PaginationControls } from "./PaginationControls";
import { LanguageCoverageChart, ModulePressureChart, SignalTrendChart } from "./SurfaceCharts";

type ComponentRow = Record<string, unknown>;
type SurfaceView = "overview" | "alerts" | "activity" | "memory";

const VIEW_LABELS: Array<{ id: SurfaceView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "alerts", label: "Alerts" },
  { id: "activity", label: "Activity" },
  { id: "memory", label: "Memory" },
];

function normalizeView(value: string | null): SurfaceView {
  if (value === "alerts" || value === "activity" || value === "memory") {
    return value;
  }

  return "overview";
}

function severityTone(severity: string | null | undefined): string {
  if (severity === "error") return "status-error";
  if (severity === "warn") return "status-warn";
  return "status-healthy";
}

function postureLabel(severity: string | null | undefined): string {
  if (severity === "error") return "critical";
  if (severity === "warn") return "warning";
  return "quiet";
}

function alertSignalLabel(alert: AlertPage["items"][number]): string {
  if (alert.type === "CONTENT_HEURISTIC" && typeof alert.evidence?.heuristicCategory === "string") {
    return alert.evidence.heuristicCategory.replaceAll("_", " ");
  }

  return alert.type.replaceAll("_", " ");
}

function heuristicCategoryValue(alert: AlertPage["items"][number]): string | null {
  return alert.type === "CONTENT_HEURISTIC" && typeof alert.evidence?.heuristicCategory === "string"
    ? alert.evidence.heuristicCategory
    : null;
}

function activityTone(item: RepoActivityItem): string {
  if (item.alertCount > 0) return "status-error";
  if (item.parserStatus === "unsupported" || item.parserStatus === "no_symbols" || item.parserStatus === "pending") {
    return "status-warn";
  }

  return "status-healthy";
}

function activityReason(item: RepoActivityItem): string {
  if (item.alertCount > 0) {
    return item.parserStatus === "unsupported" ? "heuristic fired" : "drift rule hit";
  }

  if (item.parserStatus === "unsupported") return "watched-only lane";
  if (item.parserStatus === "no_symbols") return "parsed no symbols";
  if (item.parserStatus === "pending") return "awaiting parser";
  return "below alert threshold";
}

function pressureScore(component: ComponentRow): number {
  return (
    Number(component.pressure_index ?? 0) * 1.2
    + Number(component.avg_ai_risk ?? 0)
    + Number(component.avg_cyclomatic ?? 0) * 3
    + Number(component.entropy_index ?? 0) * 0.65
  );
}

function shortTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function timeframeLimit(value: "6" | "12" | "24" | "all"): number {
  if (value === "6") return 6;
  if (value === "24") return 24;
  if (value === "all") return Number.POSITIVE_INFINITY;
  return 12;
}

export function RepoCommandCenter(props: {
  repoId: string;
  initialRepo: RepoSummary | null;
  initialComponents: ComponentRow[];
  initialAlerts: AlertPage;
  initialEntropy: RepoEntropyData;
  initialMemory: RepoMemoryData;
  initialActivity: RepoActivityPage;
}) {
  const searchParams = useSearchParams();
  const [repo, setRepo] = useState(props.initialRepo);
  const [components, setComponents] = useState(props.initialComponents);
  const [alerts, setAlerts] = useState(props.initialAlerts);
  const [entropy, setEntropy] = useState(props.initialEntropy);
  const [memory, setMemory] = useState(props.initialMemory);
  const [activity, setActivity] = useState(props.initialActivity);
  const [refreshing, setRefreshing] = useState(false);
  const [activityMode, setActivityMode] = useState<"all" | "full" | "watched">(props.initialActivity.mode ?? "all");
  const [alertHeuristicCategory, setAlertHeuristicCategory] = useState<string>("all");
  const [alertStatusFilter, setAlertStatusFilter] = useState<"all" | "open" | "acknowledged" | "resolved">("all");
  const [timeframe, setTimeframe] = useState<"6" | "12" | "24" | "all">("12");
  const [selectedView, setSelectedView] = useState<SurfaceView>(normalizeView(searchParams.get("tab")));
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(searchParams.get("alert"));
  const [selectedAlertDetail, setSelectedAlertDetail] = useState<AlertDetail | null>(null);
  const [alertDetailLoading, setAlertDetailLoading] = useState(false);
  const [alertDetailError, setAlertDetailError] = useState<string | null>(null);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setSelectedView(normalizeView(searchParams.get("tab")));
  }, [searchParams]);

  useEffect(() => {
    const alertFromUrl = searchParams.get("alert");
    if (alertFromUrl) {
      setSelectedAlertId(alertFromUrl);
      return;
    }

    if (alerts.items.length > 0 && !selectedAlertId) {
      setSelectedAlertId(alerts.items[0]?.id ?? null);
    }
  }, [alerts.items, searchParams, selectedAlertId]);

  useEffect(() => {
    let active = true;
    let queued = false;

    const refresh = async () => {
      setRefreshing(true);
      try {
        const [nextRepo, nextComponents, nextAlerts, nextEntropy, nextMemory, nextActivity] = await Promise.all([
          getRepo(props.repoId),
          getComponents(props.repoId),
          getRepoAlerts(props.repoId, {
            page: alerts.page,
            limit: alerts.pageSize,
            status: alertStatusFilter === "all" ? undefined : alertStatusFilter,
            heuristicCategory: alertHeuristicCategory === "all" ? undefined : alertHeuristicCategory,
          }),
          getRepoEntropy(props.repoId),
          getRepoMemory(props.repoId),
          getRepoActivity(props.repoId, { page: 1, limit: activity.pageSize, mode: activityMode }),
        ]);

        if (!active) {
          return;
        }

        startTransition(() => {
          setRepo(nextRepo);
          setComponents(nextComponents);
          setAlerts(nextAlerts);
          setEntropy(nextEntropy);
          setMemory(nextMemory);
          setActivity(nextActivity);
        });
      } finally {
        if (active) {
          setRefreshing(false);
        }
      }
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

    const stream = openRepoMemoryStream(props.repoId, {
      onRefresh: () => {
        queueRefresh();
      },
    });

    const interval = window.setInterval(() => {
      void refresh();
    }, 45000);

    return () => {
      active = false;
      stream?.close();
      window.clearInterval(interval);
    };
  }, [activity.pageSize, activityMode, alertHeuristicCategory, alertStatusFilter, alerts.page, alerts.pageSize, props.repoId]);

  useEffect(() => {
    if (!selectedAlertId) {
      setSelectedAlertDetail(null);
      setAlertDetailError(null);
      return;
    }

    let active = true;
    setAlertDetailLoading(true);
    setAlertDetailError(null);

    void getRepoAlertDetail(props.repoId, selectedAlertId)
      .then((detail) => {
        if (!active) {
          return;
        }

        setSelectedAlertDetail(detail);
        if (!detail) {
          setAlertDetailError("The selected alert could not be loaded.");
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        setSelectedAlertDetail(null);
        setAlertDetailError(error instanceof Error ? error.message : "Unable to load alert detail.");
      })
      .finally(() => {
        if (active) {
          setAlertDetailLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [detailRefreshToken, props.repoId, selectedAlertId]);

  async function handleAlertPageChange(page: number) {
    const next = await getRepoAlerts(props.repoId, {
      page,
      limit: alerts.pageSize,
      status: alertStatusFilter === "all" ? undefined : alertStatusFilter,
      heuristicCategory: alertHeuristicCategory === "all" ? undefined : alertHeuristicCategory,
    });
    startTransition(() => {
      setAlerts(next);
    });
  }

  async function handleAlertCategoryChange(category: string) {
    setAlertHeuristicCategory(category);
    const next = await getRepoAlerts(props.repoId, {
      page: 1,
      limit: alerts.pageSize,
      status: alertStatusFilter === "all" ? undefined : alertStatusFilter,
      heuristicCategory: category === "all" ? undefined : category,
    });
    startTransition(() => {
      setAlerts(next);
    });
  }

  async function handleAlertStatusFilterChange(status: typeof alertStatusFilter) {
    setAlertStatusFilter(status);
    const next = await getRepoAlerts(props.repoId, {
      page: 1,
      limit: alerts.pageSize,
      status: status === "all" ? undefined : status,
      heuristicCategory: alertHeuristicCategory === "all" ? undefined : alertHeuristicCategory,
    });
    startTransition(() => {
      setAlerts(next);
    });
  }

  async function handleActivityModeChange(mode: "all" | "full" | "watched") {
    setActivityMode(mode);
    const next = await getRepoActivity(props.repoId, {
      page: 1,
      limit: activity.pageSize,
      mode,
    });
    startTransition(() => {
      setActivity(next);
    });
  }

  const latestSeverity = alerts.items[0]?.severity ?? null;
  const repoEntropy = Number(repo?.entropyIndex ?? entropy.current.entropyIndex ?? 0);
  const repoPressure = Number(repo?.pressureIndex ?? (memory.current?.health.pressureIndex ?? 0));
  const activity24h = Number(repo?.activity24h ?? 0);
  const analyzedEvents24h = Number(repo?.analyzedEvents24h ?? 0);
  const unsupportedEvents24h = Number(repo?.unsupportedEvents24h ?? 0);
  const coveragePercent = Number(repo?.analysisCoveragePercent ?? 0);
  const componentPressure = [...components].sort((left, right) => pressureScore(right) - pressureScore(left));
  const topModules = componentPressure.slice(0, 8);
  const topAlerts = alerts.items.slice(0, 6);
  const alertHeuristicCategories = Array.from(new Set(
    alerts.items
      .map((alert) => heuristicCategoryValue(alert))
      .filter((value): value is string => Boolean(value)),
  ));

  const trendDataSource = memory.timeline.length > 0
    ? memory.timeline.map((frame) => ({
      label: shortTime(frame.at),
      entropy: Number(frame.entropyIndex ?? 0),
      pressure: Number(frame.pressureIndex ?? 0),
      incidents: Number(frame.incidentCount ?? 0),
    }))
    : entropy.trend.slice(-12).map((frame) => ({
      label: shortTime(frame.at),
      entropy: Number(frame.entropyIndex ?? 0),
      pressure: repoPressure,
      incidents: 0,
    }));
  const trendData = trendDataSource.slice(-timeframeLimit(timeframe));

  const moduleChartData = topModules.map((component) => ({
    name: String(component.name ?? component.id ?? "module"),
    pressure: Number(component.pressure_index ?? 0),
    entropy: Number(component.entropy_index ?? 0),
    aiRisk: Number(component.avg_ai_risk ?? 0),
  }));

  const languageCoverageData = activity.languageCoverage.slice(0, 8).map((entry) => ({
    language: entry.language,
    watchedOnlyEvents: Number(entry.watchedOnlyEvents ?? 0),
    fullPipelineEvents: Number(entry.fullPipelineEvents ?? 0),
  }));

  const criticalCount = alerts.items.filter((alert) => alert.severity === "error").length;
  const warningCount = alerts.items.filter((alert) => alert.severity === "warn").length;
  const openCount = alerts.items.filter((alert) => alert.status === "open" || !alert.status).length;
  const acknowledgedCount = alerts.items.filter((alert) => alert.status === "acknowledged").length;
  const resolvedCount = alerts.items.filter((alert) => alert.status === "resolved").length;
  const avgAiRisk = components.length === 0
    ? 0
    : components.reduce((sum, component) => sum + Number(component.avg_ai_risk ?? 0), 0) / components.length;
  const avgCyclomatic = components.length === 0
    ? 0
    : components.reduce((sum, component) => sum + Number(component.avg_cyclomatic ?? 0), 0) / components.length;
  const emptySurface = repo?.watchState === "active" && activity24h === 0;
  const selectedIncident = memory.incidents[0] ?? null;

  async function handleExportSurfaceReport() {
    setExporting(true);
    try {
      const report = await getRepoSurfaceReport(props.repoId, timeframe);
      if (!report) {
        throw new Error("Unable to generate report.");
      }

      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${repo?.name ?? props.repoId}-surface-report.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="command-main surface-workspace">
      <section className="hero hero-command surface-home-hero">
        <div className="hero-copy">
          <div className="eyebrow">Surface</div>
          <h1>{repo?.name ?? props.repoId}</h1>
          <p>
            This workspace is isolated to one repo. The key questions here are simple:
            what changed, what needs action, and what evidence supports it.
          </p>
          <div className="signal-row">
            <div className="live-indicator">
              <span className="live-dot" />
              {refreshing ? "refreshing" : repo?.watchState ?? "watching"}
            </div>
            <div className={`status-chip ${severityTone(latestSeverity)}`}>{postureLabel(latestSeverity)}</div>
            <div className="live-generated">{repo?.kind ?? "local"}</div>
          </div>
          <div className="surface-home-meta">
            {repo?.hostPath ? <div className="surface-home-path">{repo.hostPath}</div> : null}
            {repo?.remoteUrl ? <div className="surface-home-path">{repo.remoteUrl}</div> : null}
            <div className="pill-row surface-home-actions">
              <span className="pill">{coveragePercent.toFixed(0)}% coverage</span>
              <Link href={`/repos/${encodeURIComponent(props.repoId)}/refactors`} className="pill pill-cta">Open Refactors</Link>
              <button type="button" className="pill" onClick={() => void handleExportSurfaceReport()}>
                {exporting ? "Exporting..." : "Export Report"}
              </button>
            </div>
          </div>
        </div>

        <div className="hero-side">
          <div className="radar-card">
            <div className="eyebrow">Surface Snapshot</div>
            <div className="radar-grid">
              <div className="radar-cell">
                <span>components</span>
                <strong>{components.length}</strong>
              </div>
              <div className="radar-cell">
                <span>alerts</span>
                <strong>{alerts.total}</strong>
              </div>
              <div className="radar-cell">
                <span>entropy</span>
                <strong>{repoEntropy.toFixed(1)}</strong>
              </div>
              <div className="radar-cell">
                <span>pressure</span>
                <strong>{repoPressure.toFixed(1)}</strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      {emptySurface ? (
        <section className="panel surface-empty-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">No Signals Yet</div>
              <h2 className="panel-title">This surface is active but idle</h2>
            </div>
            <div className="pill">{repo?.watchState ?? "active"}</div>
          </div>
          <p className="muted">
            DriftCube is watching this repo, but it has not seen any file changes since the surface was registered.
            That is why there are no alerts, no activity rows, and no metrics yet.
          </p>
          <div className="pill-row">
            {repo?.hostPath ? <span className="pill">host {repo.hostPath}</span> : null}
            {repo?.rootPath ? <span className="pill">container {repo.rootPath}</span> : null}
          </div>
        </section>
      ) : null}

      <section className="surface-tab-bar">
        {VIEW_LABELS.map((view) => (
          <button
            key={view.id}
            type="button"
            className={`switch-pill${selectedView === view.id ? " switch-pill-active" : ""}`}
            onClick={() => setSelectedView(view.id)}
          >
            {view.label}
          </button>
        ))}
      </section>

      {selectedView === "overview" ? (
        <>
          <section className="grid cards command-cards command-cards-surface">
            <div className="panel">
              <div className="eyebrow">Critical</div>
              <strong>{criticalCount}</strong>
              <p className="muted">Error-grade findings on this surface right now.</p>
            </div>
            <div className="panel">
              <div className="eyebrow">Open</div>
              <strong>{openCount}</strong>
              <p className="muted">Findings still waiting for an operator decision.</p>
            </div>
            <div className="panel">
              <div className="eyebrow">Activity 24h</div>
              <strong>{activity24h}</strong>
              <p className="muted">Observed file events on this repo in the last day.</p>
            </div>
            <div className="panel">
              <div className="eyebrow">Coverage</div>
              <strong>{coveragePercent.toFixed(0)}%</strong>
              <p className="muted">Observed changes that entered the structural analysis lane.</p>
            </div>
          </section>

          <section className="surface-panel-grid">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Signals</div>
                  <h2 className="panel-title">Entropy vs Pressure</h2>
                </div>
                <div className="chart-toolbar">
                  <div className="pill-row">
                    {(["6", "12", "24", "all"] as const).map((option) => (
                      <button
                        key={`repo-timeframe-${option}`}
                        type="button"
                        className={`switch-pill${timeframe === option ? " switch-pill-active" : ""}`}
                        onClick={() => setTimeframe(option)}
                      >
                        {option === "all" ? "All" : `${option} Frames`}
                      </button>
                    ))}
                  </div>
                  <div className="pill">{trendData.length} frames</div>
                </div>
              </div>
              <SignalTrendChart data={trendData} />
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Modules</div>
                  <h2 className="panel-title">Pressure By Module</h2>
                </div>
                <div className="pill">{topModules.length} shown</div>
              </div>
              <ModulePressureChart data={moduleChartData} />
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Coverage</div>
                  <h2 className="panel-title">Language Analysis Mix</h2>
                </div>
                <div className="pill">{languageCoverageData.length} languages</div>
              </div>
              <LanguageCoverageChart data={languageCoverageData} />
            </section>
          </section>

          <section className="surface-panel-grid surface-panel-grid-narrow">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Top Modules</div>
                  <h2 className="panel-title">Current Hotspots</h2>
                </div>
              </div>
              <div className="surface-launch-list surface-launch-list-compact">
                {topModules.length === 0 ? <p className="muted">No component metrics recorded yet.</p> : null}
                {topModules.slice(0, 6).map((component) => (
                  <Link
                    href={`/components/${encodeURIComponent(String(component.id ?? "unknown"))}?repoId=${encodeURIComponent(props.repoId)}`}
                    key={`module-${String(component.id ?? "unknown")}`}
                    className="surface-launch-card surface-launch-card-compact"
                  >
                    <div className="surface-launch-top">
                      <strong>{String(component.name ?? component.id ?? "module")}</strong>
                      <span className="pill">{Number(component.pressure_index ?? 0).toFixed(1)} pressure</span>
                    </div>
                    <div className="surface-launch-meta">
                      <span>entropy {Number(component.entropy_index ?? 0).toFixed(1)}</span>
                      <span>ai {Number(component.avg_ai_risk ?? 0).toFixed(1)}</span>
                      <span>cyclo {Number(component.avg_cyclomatic ?? 0).toFixed(1)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Recent Findings</div>
                  <h2 className="panel-title">Latest Alerts</h2>
                </div>
                <button type="button" className="pill" onClick={() => setSelectedView("alerts")}>
                  open alerts
                </button>
              </div>
              <div className="alert-list alert-list-paged">
                {topAlerts.length === 0 ? <p className="muted">No alerts have landed on this surface yet.</p> : null}
                {topAlerts.map((alert) => (
                  <button
                    type="button"
                    key={alert.id}
                    className={`alert-card alert-card-dense alert-card-button${selectedAlertId === alert.id ? " alert-card-selected" : ""}`}
                    onClick={() => {
                      setSelectedView("alerts");
                      setSelectedAlertId(alert.id);
                    }}
                  >
                    <span className={`alert-card-edge ${severityTone(alert.severity)}`} />
                    <div className="alert-card-top">
                      <span className={`severity-badge ${severityTone(alert.severity)}`}>{alertSignalLabel(alert)}</span>
                      <span className={`status-chip ${alert.status === "resolved" ? "status-healthy" : alert.status === "acknowledged" ? "status-warn" : "status-error"}`}>
                        {alert.status ?? "open"}
                      </span>
                      <span className="muted">{shortTime(alert.at)}</span>
                    </div>
                    <div className="alert-card-title">{alert.title}</div>
                  </button>
                ))}
              </div>
            </section>
          </section>
        </>
      ) : null}

      {selectedView === "alerts" ? (
        <section className="surface-alert-grid">
          <section className="panel surface-alert-rail">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Alert Rail</div>
                <h2 className="panel-title">Findings For This Surface</h2>
              </div>
              <div className="pill">{alerts.total} total</div>
            </div>

            <div className="surface-alert-stats">
              <div className="surface-alert-stat">
                <span>Open</span>
                <strong>{openCount}</strong>
              </div>
              <div className="surface-alert-stat">
                <span>Ack</span>
                <strong>{acknowledgedCount}</strong>
              </div>
              <div className="surface-alert-stat">
                <span>Resolved</span>
                <strong>{resolvedCount}</strong>
              </div>
            </div>

            <div className="surface-alert-filters">
              <div className="pill-row">
                {(["all", "open", "acknowledged", "resolved"] as const).map((status) => (
                  <button
                    key={`repo-alert-status-${status}`}
                    type="button"
                    className={`switch-pill${alertStatusFilter === status ? " switch-pill-active" : ""}`}
                    onClick={() => void handleAlertStatusFilterChange(status)}
                  >
                    {status}
                  </button>
                ))}
              </div>
              <div className="pill-row">
                <button
                  type="button"
                  className={`switch-pill${alertHeuristicCategory === "all" ? " switch-pill-active" : ""}`}
                  onClick={() => void handleAlertCategoryChange("all")}
                >
                  All Categories
                </button>
                {alertHeuristicCategories.map((category) => (
                  <button
                    key={`repo-alert-cat-${category}`}
                    type="button"
                    className={`switch-pill${alertHeuristicCategory === category ? " switch-pill-active" : ""}`}
                    onClick={() => void handleAlertCategoryChange(category)}
                  >
                    {category.replaceAll("_", " ")}
                  </button>
                ))}
              </div>
            </div>

            <div className="alert-list alert-list-paged">
              {alerts.items.length === 0 ? <p className="muted">No alerts have landed for this repository yet.</p> : null}
              {alerts.items.map((alert) => (
                <button
                  type="button"
                  key={alert.id}
                  className={`alert-card alert-card-dense alert-card-button${selectedAlertId === alert.id ? " alert-card-selected" : ""}`}
                  onClick={() => setSelectedAlertId(alert.id)}
                >
                  <span className={`alert-card-edge ${severityTone(alert.severity)}`} />
                  <div className="alert-card-top">
                    <span className={`severity-badge ${severityTone(alert.severity)}`}>{alertSignalLabel(alert)}</span>
                    <span className={`status-chip ${alert.status === "resolved" ? "status-healthy" : alert.status === "acknowledged" ? "status-warn" : "status-error"}`}>
                      {alert.status ?? "open"}
                    </span>
                    <span className="muted">{shortTime(alert.at)}</span>
                  </div>
                  <div className="alert-card-title">{alert.title}</div>
                  <div className="alert-card-meta">
                    <span>{String(alert.evidence?.filePath ?? alert.evidence?.module ?? alert.evidence?.symbolId ?? "surface signal")}</span>
                  </div>
                </button>
              ))}
            </div>

            <PaginationControls
              page={alerts.page}
              totalItems={alerts.total}
              totalPages={alerts.totalPages}
              label="Alert Page"
              onPageChange={(page) => void handleAlertPageChange(page)}
            />
          </section>

          <section className="surface-alert-detail">
            <AlertDetailDrawer
              repoId={props.repoId}
              detail={selectedAlertDetail}
              loading={alertDetailLoading}
              error={alertDetailError}
              onCommentAdded={() => {
                setDetailRefreshToken((value) => value + 1);
                void handleAlertPageChange(alerts.page);
              }}
            />
          </section>
        </section>
      ) : null}

      {selectedView === "activity" ? (
        <section className="surface-panel-grid">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Activity Coverage</div>
                <h2 className="panel-title">What DriftCube Saw</h2>
              </div>
              <div className="pill">{activity.total} events</div>
            </div>
            <div className="memory-delta-grid">
              <div className="memory-delta-card">
                <span>activity</span>
                <strong>{activity24h}</strong>
              </div>
              <div className="memory-delta-card">
                <span>analyzed</span>
                <strong>{analyzedEvents24h}</strong>
              </div>
              <div className="memory-delta-card">
                <span>watched only</span>
                <strong>{unsupportedEvents24h}</strong>
              </div>
              <div className="memory-delta-card">
                <span>coverage</span>
                <strong>{coveragePercent.toFixed(0)}%</strong>
              </div>
            </div>
            <LanguageCoverageChart data={languageCoverageData} />
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Live File Stream</div>
                <h2 className="panel-title">Recent Surface Activity</h2>
              </div>
              <div className="pill">{activityMode}</div>
            </div>

            <div className="pill-row">
              <button
                type="button"
                className={`switch-pill${activityMode === "all" ? " switch-pill-active" : ""}`}
                onClick={() => void handleActivityModeChange("all")}
              >
                All Activity
              </button>
              <button
                type="button"
                className={`switch-pill${activityMode === "full" ? " switch-pill-active" : ""}`}
                onClick={() => void handleActivityModeChange("full")}
              >
                Full Analysis
              </button>
              <button
                type="button"
                className={`switch-pill${activityMode === "watched" ? " switch-pill-active" : ""}`}
                onClick={() => void handleActivityModeChange("watched")}
              >
                Watched Only
              </button>
            </div>

            <div className="note-timeline">
              {activity.items.length === 0 ? (
                <p className="muted">No file changes have been observed for this surface yet.</p>
              ) : null}
              {activity.items.map((item) => (
                <div key={item.eventId} className="note-card">
                  <div className="note-card-top">
                    <span className={`severity-badge ${activityTone(item)}`}>{item.parserStatus}</span>
                    <span className="muted">{new Date(item.at).toLocaleString()}</span>
                  </div>
                  <strong>{item.filePath}</strong>
                  <p className="muted">{item.note ?? "Watched live."}</p>
                  <div className="pill-row">
                    <span className="pill">{item.changeType}</span>
                    <span className="pill">{item.language ?? "unknown"}</span>
                    <span className={`pill ${activityTone(item)}`}>{activityReason(item)}</span>
                    {item.provenance && item.provenance !== "unknown" ? <span className="pill">{item.provenance}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </section>
      ) : null}

      {selectedView === "memory" ? (
        <section className="surface-panel-grid">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Architecture Memory</div>
                <h2 className="panel-title">Current vs Healthy</h2>
              </div>
              <div className="pill">{memory.timeline.length} frames</div>
            </div>
            <SignalTrendChart data={trendData} />
            <div className="memory-delta-grid">
              <div className="memory-delta-card">
                <span>current entropy</span>
                <strong>{Number(memory.current?.health.entropyIndex ?? repoEntropy).toFixed(1)}</strong>
              </div>
              <div className="memory-delta-card">
                <span>baseline entropy</span>
                <strong>{Number(memory.baseline?.health.entropyIndex ?? 0).toFixed(1)}</strong>
              </div>
              <div className="memory-delta-card">
                <span>delta pressure</span>
                <strong>{Number(memory.delta?.pressureIndex ?? 0).toFixed(1)}</strong>
              </div>
              <div className="memory-delta-card">
                <span>delta violations</span>
                <strong>{Number(memory.delta?.archViolations ?? 0).toFixed(0)}</strong>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Incident Memory</div>
                <h2 className="panel-title">Latest Incident</h2>
              </div>
              <Link href="/fleet" className="pill">open fleet context</Link>
            </div>

            {selectedIncident ? (
              <div className="note-timeline">
                <div className="note-card">
                  <div className="note-card-top">
                    <span className={`severity-badge ${severityTone(selectedIncident.severity)}`}>{selectedIncident.type}</span>
                    <span className={`status-chip ${selectedIncident.status === "open" ? "status-error" : "status-healthy"}`}>{selectedIncident.status}</span>
                  </div>
                  <strong>{selectedIncident.subjectId}</strong>
                  <p className="muted">{selectedIncident.latestAlertTitle ?? selectedIncident.openedAlertTitle ?? "incident"}</p>
                  <div className="pill-row">
                    <span className="pill">opened {new Date(selectedIncident.openedAt).toLocaleString()}</span>
                    {selectedIncident.closedAt ? <span className="pill">closed {new Date(selectedIncident.closedAt).toLocaleString()}</span> : null}
                  </div>
                  <div className="memory-delta-grid">
                    <div className="memory-delta-card">
                      <span>opened to latest entropy</span>
                      <strong>{Number(selectedIncident.deltas.openedToLatest?.entropyIndex ?? 0).toFixed(1)}</strong>
                    </div>
                    <div className="memory-delta-card">
                      <span>opened to latest pressure</span>
                      <strong>{Number(selectedIncident.deltas.openedToLatest?.pressureIndex ?? 0).toFixed(1)}</strong>
                    </div>
                    <div className="memory-delta-card">
                      <span>recovered entropy</span>
                      <strong>{Number(selectedIncident.deltas.openedToRecovered?.entropyIndex ?? 0).toFixed(1)}</strong>
                    </div>
                    <div className="memory-delta-card">
                      <span>recovered pressure</span>
                      <strong>{Number(selectedIncident.deltas.openedToRecovered?.pressureIndex ?? 0).toFixed(1)}</strong>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <p className="muted">Incident memory will appear once entropy or pressure anomalies open on this surface.</p>
            )}
          </section>
        </section>
      ) : null}
    </main>
  );
}
