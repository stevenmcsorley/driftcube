"use client";

import Link from "next/link";
import { startTransition, useEffect, useState } from "react";
import { getGlobalAlerts, type AlertPage } from "../lib/api";
import { PaginationControls } from "./PaginationControls";

function severityTone(severity: string | null | undefined): string {
  if (severity === "error") return "status-error";
  if (severity === "warn") return "status-warn";
  return "status-healthy";
}

function alertTarget(evidence: Record<string, unknown> | undefined): string | null {
  if (!evidence) {
    return null;
  }

  const module = typeof evidence.module === "string" ? evidence.module : null;
  const filePath = typeof evidence.filePath === "string" ? evidence.filePath : null;
  const symbolId = typeof evidence.symbolId === "string" ? evidence.symbolId : null;

  return module ?? filePath ?? symbolId;
}

function alertSignalLabel(alert: AlertPage["items"][number]): string {
  if (alert.type === "CONTENT_HEURISTIC" && typeof alert.evidence?.heuristicCategory === "string") {
    return alert.evidence.heuristicCategory.replaceAll("_", " ");
  }

  return alert.type.replaceAll("_", " ");
}

export function GlobalAlertStream(props: {
  initialPage: AlertPage;
}) {
  const [pageData, setPageData] = useState(props.initialPage);
  const [loading, setLoading] = useState(false);
  const [heuristicCategory, setHeuristicCategory] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "acknowledged" | "resolved">("all");

  const categories = Array.from(new Set(
    pageData.items
      .map((alert) => (alert.type === "CONTENT_HEURISTIC" && typeof alert.evidence?.heuristicCategory === "string"
        ? alert.evidence.heuristicCategory
        : null))
      .filter((value): value is string => Boolean(value)),
  ));

  async function loadPage(page: number) {
    setLoading(true);
    const next = await getGlobalAlerts({
      page,
      limit: pageData.pageSize,
      status: statusFilter === "all" ? undefined : statusFilter,
      heuristicCategory: heuristicCategory === "all" ? undefined : heuristicCategory,
    });
    startTransition(() => {
      setPageData(next);
    });
    setLoading(false);
  }

  async function handleCategoryChange(category: string) {
    setHeuristicCategory(category);
    setLoading(true);
    const next = await getGlobalAlerts({
      page: 1,
      limit: pageData.pageSize,
      status: statusFilter === "all" ? undefined : statusFilter,
      heuristicCategory: category === "all" ? undefined : category,
    });
    startTransition(() => {
      setPageData(next);
    });
    setLoading(false);
  }

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      const next = await getGlobalAlerts({
        page: pageData.page,
        limit: pageData.pageSize,
        status: statusFilter === "all" ? undefined : statusFilter,
        heuristicCategory: heuristicCategory === "all" ? undefined : heuristicCategory,
      });
      if (!active) {
        return;
      }

      startTransition(() => {
        setPageData(next);
      });
    };

    const interval = window.setInterval(refresh, 8000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [heuristicCategory, pageData.page, pageData.pageSize, statusFilter]);

  async function handleStatusChange(status: typeof statusFilter) {
    setStatusFilter(status);
    setLoading(true);
    const next = await getGlobalAlerts({
      page: 1,
      limit: pageData.pageSize,
      status: status === "all" ? undefined : status,
      heuristicCategory: heuristicCategory === "all" ? undefined : heuristicCategory,
    });
    startTransition(() => {
      setPageData(next);
    });
    setLoading(false);
  }

  const openCount = pageData.items.filter((alert) => alert.status === "open" || !alert.status).length;
  const acknowledgedCount = pageData.items.filter((alert) => alert.status === "acknowledged").length;
  const resolvedCount = pageData.items.filter((alert) => alert.status === "resolved").length;

  return (
    <section className="panel alert-stream-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Global Rail</div>
          <h2 className="panel-title">Latest Incidents</h2>
        </div>
        <div className="pill">{loading ? "refreshing" : `${pageData.total} tracked`}</div>
      </div>
      <div className="surface-alert-stats">
        <div className="surface-alert-stat">
          <span>Open</span>
          <strong>{openCount}</strong>
        </div>
        <div className="surface-alert-stat">
          <span>Acknowledged</span>
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
              key={`global-alert-status-${status}`}
              type="button"
              className={`switch-pill${statusFilter === status ? " switch-pill-active" : ""}`}
              onClick={() => void handleStatusChange(status)}
            >
              {status}
            </button>
          ))}
        </div>
        <div className="pill-row">
          <button
            type="button"
            className={`switch-pill${heuristicCategory === "all" ? " switch-pill-active" : ""}`}
            onClick={() => void handleCategoryChange("all")}
          >
            All Categories
          </button>
          {categories.map((category) => (
            <button
              key={`global-alert-cat-${category}`}
              type="button"
              className={`switch-pill${heuristicCategory === category ? " switch-pill-active" : ""}`}
              onClick={() => void handleCategoryChange(category)}
            >
              {category.replaceAll("_", " ")}
            </button>
          ))}
        </div>
      </div>

      <div className="alert-list alert-list-paged">
        {pageData.items.length === 0 ? <p className="muted">No alerts have landed yet.</p> : null}
        {pageData.items.map((alert) => (
          <Link
            href={alert.repoId ? `/repos/${encodeURIComponent(alert.repoId)}?tab=alerts&alert=${encodeURIComponent(alert.id)}` : "/alerts"}
            key={alert.id}
            className="alert-card alert-card-dense"
          >
            <span className={`alert-card-edge ${severityTone(alert.severity)}`} />
            <div className="alert-card-top">
              <span className={`severity-badge ${severityTone(alert.severity)}`}>{alertSignalLabel(alert)}</span>
              <span className={`status-chip ${alert.status === "resolved" ? "status-healthy" : alert.status === "acknowledged" ? "status-warn" : "status-error"}`}>
                {alert.status ?? "open"}
              </span>
              <span className="muted">{new Date(alert.at).toLocaleTimeString()}</span>
            </div>
            <div className="alert-card-title">{alert.title}</div>
            <div className="alert-card-meta">
              <span>{alert.repoId ?? "repo"} · {alertTarget(alert.evidence) ?? "surface signal"}</span>
            </div>
          </Link>
        ))}
      </div>

      <PaginationControls
        page={pageData.page}
        totalItems={pageData.total}
        totalPages={pageData.totalPages}
        label="Alert Page"
        onPageChange={(page) => void loadPage(page)}
      />
    </section>
  );
}
