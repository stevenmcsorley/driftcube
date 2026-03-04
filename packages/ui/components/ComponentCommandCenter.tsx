"use client";

import { useMemo, useState } from "react";
import { AlertDetailDrawer } from "./AlertDetailDrawer";
import { GraphDiff } from "./GraphDiff";
import { Neighbours } from "./Neighbours";
import { ModulePressureChart, SignalTrendChart } from "./SurfaceCharts";
import { getComponentSurfaceReport, getRepoAlertDetail, type AlertDetail } from "../lib/api";

type ComponentView = "overview" | "alerts" | "activity" | "graph";

function timeframeLimit(value: "6" | "12" | "24" | "all"): number {
  if (value === "6") return 6;
  if (value === "24") return 24;
  if (value === "all") return Number.POSITIVE_INFINITY;
  return 12;
}

function severityTone(severity: string | null | undefined): string {
  if (severity === "error") return "status-error";
  if (severity === "warn") return "status-warn";
  return "status-healthy";
}

function alertSignalLabel(alert: Record<string, unknown>): string {
  const type = String(alert.type ?? "");
  const evidence = typeof alert.evidence === "object" && alert.evidence ? alert.evidence as Record<string, unknown> : {};
  if (type === "CONTENT_HEURISTIC" && typeof evidence.heuristicCategory === "string") {
    return evidence.heuristicCategory.replaceAll("_", " ");
  }

  return type.replaceAll("_", " ");
}

function latestMetricValue(metrics: Array<Record<string, unknown>>, key: string, scope?: string): number {
  const match = metrics.find((metric) => (
    String(metric.key ?? "") === key
    && (scope ? String(metric.scope ?? "") === scope : true)
  ));

  return Number(match?.value ?? 0);
}

export function ComponentCommandCenter(props: {
  repoId: string;
  componentId: string;
  component: Record<string, unknown> | null;
}) {
  const [view, setView] = useState<ComponentView>("overview");
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(
    Array.isArray(props.component?.alerts) && props.component?.alerts.length > 0
      ? String((props.component.alerts as Array<Record<string, unknown>>)[0]?.id ?? "")
      : null,
  );
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<"6" | "12" | "24" | "all">("12");
  const [exporting, setExporting] = useState(false);

  const summary = (props.component?.summary as Record<string, unknown> | undefined) ?? {};
  const metrics = Array.isArray(props.component?.metrics) ? props.component?.metrics as Array<Record<string, unknown>> : [];
  const alerts = Array.isArray(props.component?.alerts) ? props.component?.alerts as Array<Record<string, unknown>> : [];
  const activity = Array.isArray(props.component?.activity) ? props.component?.activity as Array<Record<string, unknown>> : [];

  const graphEdgesAdded = useMemo(() => alerts.flatMap((alert) => {
    const evidence = typeof alert.evidence === "object" && alert.evidence ? alert.evidence as Record<string, unknown> : {};
    return Array.isArray(evidence.graphEdgesAdded) ? evidence.graphEdgesAdded.map((edge) => String(edge)) : [];
  }), [alerts]);
  const graphEdgesRemoved = useMemo(() => alerts.flatMap((alert) => {
    const evidence = typeof alert.evidence === "object" && alert.evidence ? alert.evidence as Record<string, unknown> : {};
    return Array.isArray(evidence.graphEdgesRemoved) ? evidence.graphEdgesRemoved.map((edge) => String(edge)) : [];
  }), [alerts]);
  const neighbours = useMemo(() => alerts.flatMap((alert) => {
    const evidence = typeof alert.evidence === "object" && alert.evidence ? alert.evidence as Record<string, unknown> : {};
    return Array.isArray(evidence.neighbours)
      ? evidence.neighbours.map((item) => {
        const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
        return {
          id: String(record.id ?? "unknown"),
          score: Number(record.score ?? 0),
        };
      })
      : [];
  }), [alerts]);

  const metricSeries = useMemo(() => {
    const groups = new Map<string, { label: string; entropy: number; pressure: number }>();
    for (const metric of metrics.slice(0, 80).reverse()) {
      const at = String(metric.at ?? "");
      if (!at) continue;
      const label = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const current = groups.get(label) ?? { label, entropy: 0, pressure: 0 };
      if (String(metric.key ?? "") === "code_entropy_index") {
        current.entropy = Number(metric.value ?? 0);
      }
      if (String(metric.key ?? "") === "pressure_index") {
        current.pressure = Number(metric.value ?? 0);
      }
      groups.set(label, current);
    }
    return [...groups.values()].slice(-timeframeLimit(timeframe));
  }, [metrics, timeframe]);

  const moduleChartData = useMemo(() => [{
    name: props.componentId,
    pressure: Number(summary.pressure_index ?? latestMetricValue(metrics, "pressure_index", "module")),
    entropy: Number(summary.entropy_index ?? latestMetricValue(metrics, "code_entropy_index", "module")),
    aiRisk: Number(summary.avg_ai_risk ?? latestMetricValue(metrics, "ai_risk_score", "symbol")),
  }], [metrics, props.componentId, summary]);

  async function openAlert(alertId: string) {
    setSelectedAlertId(alertId);
    setView("alerts");
    setDetailLoading(true);
    setDetailError(null);
    try {
      const next = await getRepoAlertDetail(props.repoId, alertId);
      setDetail(next);
      if (!next) {
        setDetailError("The selected alert could not be loaded.");
      }
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : "Unable to load alert detail.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleExportReport() {
    setExporting(true);
    try {
      const report = await getComponentSurfaceReport(props.repoId, props.componentId, timeframe);
      if (!report) {
        throw new Error("Unable to generate component report.");
      }

      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${props.componentId}-component-report.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="command-main surface-workspace">
      <section className="workspace-header">
        <div className="workspace-header-body">
          <div className="workspace-header-copy">
            <div className="eyebrow">Component Surface</div>
            <h1>{props.componentId}</h1>
            <p>{String(props.component?.intent ?? `Monitor ${props.componentId} for structural and semantic drift.`)}</p>
            <div className="workspace-header-meta">
              <div className="live-indicator">
                <span className="live-dot" />
                module focus
              </div>
              <div className={`status-chip ${severityTone(alerts[0]?.severity ? String(alerts[0].severity) : null)}`}>
                {alerts.length > 0 ? "active findings" : "quiet"}
              </div>
              <button type="button" className="pill" onClick={() => void handleExportReport()}>
                {exporting ? "Exporting..." : "Export Report"}
              </button>
            </div>
          </div>

          <div className="workspace-header-side">
            <div className="metric-strip metric-strip-dense">
              <div className="metric-tile">
                <span>alerts</span>
                <strong>{alerts.length}</strong>
              </div>
              <div className="metric-tile">
                <span>cyclomatic</span>
                <strong>{Number(summary.avg_cyclomatic ?? 0).toFixed(1)}</strong>
              </div>
              <div className="metric-tile">
                <span>ai risk</span>
                <strong>{Number(summary.avg_ai_risk ?? 0).toFixed(1)}</strong>
              </div>
            </div>
            <div className="metric-tile">
              <span>pressure</span>
              <strong>{Number(summary.pressure_index ?? 0).toFixed(1)}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="surface-tab-bar">
        <button type="button" className={`switch-pill${view === "overview" ? " switch-pill-active" : ""}`} onClick={() => setView("overview")}>Overview</button>
        <button type="button" className={`switch-pill${view === "alerts" ? " switch-pill-active" : ""}`} onClick={() => setView("alerts")}>Alerts</button>
        <button type="button" className={`switch-pill${view === "activity" ? " switch-pill-active" : ""}`} onClick={() => setView("activity")}>Activity</button>
        <button type="button" className={`switch-pill${view === "graph" ? " switch-pill-active" : ""}`} onClick={() => setView("graph")}>Graph</button>
      </section>

      {view === "overview" ? (
        <>
          <section className="metric-strip">
            <div className="metric-tile">
              <span>Cyclomatic</span>
              <strong>{Number(summary.avg_cyclomatic ?? 0).toFixed(1)}</strong>
            </div>
            <div className="metric-tile">
              <span>AI Risk</span>
              <strong>{Number(summary.avg_ai_risk ?? 0).toFixed(1)}</strong>
            </div>
            <div className="metric-tile">
              <span>Entropy</span>
              <strong>{Number(summary.entropy_index ?? 0).toFixed(1)}</strong>
            </div>
            <div className="metric-tile">
              <span>Pressure</span>
              <strong>{Number(summary.pressure_index ?? 0).toFixed(1)}</strong>
            </div>
          </section>

          <section className="surface-panel-grid">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Component Trend</div>
                  <h2 className="panel-title">Entropy vs Pressure</h2>
                </div>
                <div className="chart-toolbar">
                  <div className="pill-row">
                    {(["6", "12", "24", "all"] as const).map((option) => (
                      <button
                        key={`component-timeframe-${option}`}
                        type="button"
                        className={`switch-pill${timeframe === option ? " switch-pill-active" : ""}`}
                        onClick={() => setTimeframe(option)}
                      >
                        {option === "all" ? "All" : `${option} Frames`}
                      </button>
                    ))}
                  </div>
                  <div className="pill">{metricSeries.length} frames</div>
                </div>
              </div>
              <SignalTrendChart data={metricSeries} />
            </section>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Module Signals</div>
                  <h2 className="panel-title">Current Balance</h2>
                </div>
              </div>
              <ModulePressureChart data={moduleChartData} />
            </section>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Current Findings</div>
                <h2 className="panel-title">Alerts On This Component</h2>
              </div>
            </div>
            <div className="alert-list alert-list-paged">
              {alerts.length === 0 ? <p className="muted">No component-specific alerts have landed yet.</p> : null}
              {alerts.slice(0, 6).map((alert) => (
                <button
                  type="button"
                  key={String(alert.id ?? alert.title ?? "alert")}
                  className={`alert-card alert-card-dense alert-card-button${selectedAlertId === String(alert.id ?? "") ? " alert-card-selected" : ""}`}
                  onClick={() => void openAlert(String(alert.id ?? ""))}
                >
                  <span className={`alert-card-edge ${severityTone(String(alert.severity ?? ""))}`} />
                  <div className="alert-card-top">
                    <span className={`severity-badge ${severityTone(String(alert.severity ?? ""))}`}>{alertSignalLabel(alert)}</span>
                    <span className={`status-chip ${String(alert.status ?? "open") === "resolved" ? "status-healthy" : String(alert.status ?? "open") === "acknowledged" ? "status-warn" : "status-error"}`}>
                      {String(alert.status ?? "open")}
                    </span>
                    <span className="muted">{String(alert.at ?? "") ? new Date(String(alert.at)).toLocaleString() : ""}</span>
                  </div>
                  <div className="alert-card-title">{String(alert.title ?? "alert")}</div>
                </button>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {view === "alerts" ? (
        <section className="surface-alert-grid">
          <section className="panel surface-alert-rail">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Component Alerts</div>
                <h2 className="panel-title">Focused Findings</h2>
              </div>
              <div className="pill">{alerts.length} alerts</div>
            </div>
            <div className="alert-list alert-list-paged">
              {alerts.length === 0 ? <p className="muted">No alerts exist for this component yet.</p> : null}
              {alerts.map((alert) => (
                <button
                  type="button"
                  key={String(alert.id ?? alert.title ?? "alert")}
                  className={`alert-card alert-card-dense alert-card-button${selectedAlertId === String(alert.id ?? "") ? " alert-card-selected" : ""}`}
                  onClick={() => void openAlert(String(alert.id ?? ""))}
                >
                  <span className={`alert-card-edge ${severityTone(String(alert.severity ?? ""))}`} />
                  <div className="alert-card-top">
                    <span className={`severity-badge ${severityTone(String(alert.severity ?? ""))}`}>{alertSignalLabel(alert)}</span>
                    <span className={`status-chip ${String(alert.status ?? "open") === "resolved" ? "status-healthy" : String(alert.status ?? "open") === "acknowledged" ? "status-warn" : "status-error"}`}>
                      {String(alert.status ?? "open")}
                    </span>
                    <span className="muted">{String(alert.at ?? "") ? new Date(String(alert.at)).toLocaleString() : ""}</span>
                  </div>
                  <div className="alert-card-title">{String(alert.title ?? "alert")}</div>
                </button>
              ))}
            </div>
          </section>

          <section className="surface-alert-detail">
            <AlertDetailDrawer
              repoId={props.repoId}
              detail={detail}
              loading={detailLoading}
              error={detailError}
              onCommentAdded={() => {
                if (selectedAlertId) {
                  void openAlert(selectedAlertId);
                }
              }}
            />
          </section>
        </section>
      ) : null}

      {view === "activity" ? (
        <section className="surface-panel-grid">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Component Activity</div>
                <h2 className="panel-title">Recent File Churn</h2>
              </div>
              <div className="pill">{activity.length} events</div>
            </div>
            <div className="note-timeline">
              {activity.length === 0 ? <p className="muted">No live file activity has been matched to this component yet.</p> : null}
              {activity.map((item) => (
                <div key={String(item.eventId ?? item.filePath ?? "activity")} className="note-card">
                  <div className="note-card-top">
                    <span className={`severity-badge ${Number(item.alertCount ?? 0) > 0 ? "status-error" : String(item.parserStatus ?? "") === "unsupported" ? "status-warn" : "status-healthy"}`}>
                      {String(item.parserStatus ?? "activity")}
                    </span>
                    <span className="muted">{String(item.at ?? "") ? new Date(String(item.at)).toLocaleString() : ""}</span>
                  </div>
                  <strong>{String(item.filePath ?? "file")}</strong>
                  <p className="muted">{String(item.note ?? "Watched live.")}</p>
                  <div className="pill-row">
                    <span className="pill">{String(item.changeType ?? "modified")}</span>
                    <span className="pill">{String(item.language ?? "unknown")}</span>
                    <span className="pill">{Number(item.symbolCount ?? 0)} symbols</span>
                    <span className="pill">{Number(item.alertCount ?? 0)} alerts</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </section>
      ) : null}

      {view === "graph" ? (
        <section className="surface-panel-grid">
          <GraphDiff addedEdges={Array.from(new Set(graphEdgesAdded))} removedEdges={Array.from(new Set(graphEdgesRemoved))} />
          <Neighbours neighbours={neighbours} />
        </section>
      ) : null}
    </main>
  );
}
