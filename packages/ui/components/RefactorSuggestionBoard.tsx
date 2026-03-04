"use client";

import { startTransition, useState } from "react";
import {
  generateRepoRefactors,
  getRepoRefactors,
  updateRepoRefactorStatus,
  type RefactorPage,
  type RepoSummary,
} from "../lib/api";
import { PaginationControls } from "./PaginationControls";

function typeLabel(type: string): string {
  return type.replaceAll("_", " ");
}

function impactValue(value: number | undefined): string {
  if (!Number.isFinite(value)) {
    return "0.00";
  }

  return `${value && value > 0 ? "+" : ""}${value?.toFixed(2) ?? "0.00"}`;
}

function statusTone(status: string | undefined): string {
  if (status === "applied") return "status-healthy";
  if (status === "accepted") return "status-warn";
  if (status === "dismissed") return "status-error";
  return "status-healthy";
}

export function RefactorSuggestionBoard(props: {
  repoId: string;
  repo: RepoSummary | null;
  initialPage: RefactorPage;
}) {
  const [page, setPage] = useState(props.initialPage);
  const [generating, setGenerating] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "proposed" | "accepted" | "applied" | "dismissed">("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const result = await generateRepoRefactors(props.repoId);
      startTransition(() => {
        setPage({
          items: result.items.slice(0, props.initialPage.pageSize),
          total: result.total,
          page: 1,
          pageSize: props.initialPage.pageSize,
          totalPages: Math.max(1, Math.ceil(result.total / props.initialPage.pageSize)),
        });
        setGeneratedAt(result.generatedAt);
      });
    } finally {
      setGenerating(false);
    }
  }

  async function handlePageChange(nextPage: number) {
    const result = await getRepoRefactors(props.repoId, {
      page: nextPage,
      limit: page.pageSize,
      status: statusFilter === "all" ? undefined : statusFilter,
    });
    startTransition(() => {
      setPage(result);
    });
  }

  async function handleFilterChange(nextStatus: typeof statusFilter) {
    setStatusFilter(nextStatus);
    const result = await getRepoRefactors(props.repoId, {
      page: 1,
      limit: page.pageSize,
      status: nextStatus === "all" ? undefined : nextStatus,
    });
    startTransition(() => {
      setPage(result);
    });
  }

  async function handleStatusChange(refactorId: string, status: "proposed" | "accepted" | "applied" | "dismissed") {
    setBusyId(refactorId);
    try {
      const result = await updateRepoRefactorStatus(props.repoId, refactorId, status);
      startTransition(() => {
        setPage((current) => {
          const updatedItems = current.items
            .map((item) => (item.id === refactorId ? result.item : item))
            .filter((item) => statusFilter === "all" || item.status === statusFilter);

          return {
            ...current,
            items: updatedItems,
          };
        });
      });
    } finally {
      setBusyId(null);
    }
  }

  const strongest = page.items[0];
  const highConfidence = page.items.filter((item) => item.confidence >= 0.8).length;
  const acceptedCount = page.items.filter((item) => item.status === "accepted").length;
  const appliedCount = page.items.filter((item) => item.status === "applied").length;

  return (
    <main className="stack">
      <section className="workspace-header">
        <div className="workspace-header-body">
          <div className="workspace-header-copy">
            <div className="eyebrow">Refactor Engine</div>
            <h1>{props.repo?.name ?? props.repoId}</h1>
            <p>Ranked, evidence-backed refactor suggestions generated from pressure, entropy, duplication, and boundary drift.</p>
            <div className="repo-manager-actions">
              <button type="button" className="switch-pill switch-pill-active" disabled={generating} onClick={() => void handleGenerate()}>
                {generating ? "Generating..." : "Generate Suggestions"}
              </button>
              {(["all", "proposed", "accepted", "applied", "dismissed"] as const).map((status) => (
                <button
                  type="button"
                  key={status}
                  className={`switch-pill${statusFilter === status ? " switch-pill-active" : ""}`}
                  onClick={() => void handleFilterChange(status)}
                  aria-pressed={statusFilter === status}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>
          <div className="workspace-header-side">
            <div className="metric-strip metric-strip-dense">
              <div className="metric-tile">
                <span>Suggestions</span>
                <strong>{page.total}</strong>
              </div>
              <div className="metric-tile">
                <span>High Confidence</span>
                <strong>{highConfidence}</strong>
              </div>
              <div className="metric-tile">
                <span>Accepted</span>
                <strong>{acceptedCount}</strong>
              </div>
            </div>
            <div className="metric-strip metric-strip-dense">
              <div className="metric-tile">
                <span>Applied</span>
                <strong>{appliedCount}</strong>
              </div>
              <div className="metric-tile">
                <span>Top Type</span>
                <strong>{strongest ? typeLabel(strongest.type) : "none"}</strong>
              </div>
              <div className="metric-tile">
                <span>Generated</span>
                <strong>{generatedAt ? new Date(generatedAt).toLocaleTimeString() : "cached"}</strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="refactor-grid">
        {page.items.length === 0 ? (
          <div className="panel">
            <div className="eyebrow">No Suggestions</div>
            <p className="muted">Generate suggestions for this surface to see ranked refactor plans.</p>
          </div>
        ) : null}

        {page.items.map((suggestion) => (
          <article key={suggestion.id} className="panel refactor-card">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">{typeLabel(suggestion.type)}</div>
                <h2 className="panel-title">{suggestion.target}</h2>
              </div>
              <div className="pill-row">
                <span className={`status-chip ${statusTone(suggestion.status)}`}>{suggestion.status ?? "proposed"}</span>
                <div className="pill">{suggestion.confidence.toFixed(2)} confidence</div>
              </div>
            </div>
            <div className="pill-row">
              <span className="pill">{suggestion.scope}</span>
              <span className="pill">{suggestion.evidence.topDrivers.length} drivers</span>
              <span className="pill">{suggestion.plan.length} steps</span>
            </div>

            <div className="refactor-impact-grid">
              <div className="signal-block">
                <span>entropy</span>
                <strong>{impactValue(suggestion.impact.entropyDelta)}</strong>
              </div>
              <div className="signal-block">
                <span>pressure</span>
                <strong>{impactValue(suggestion.impact.pressureDelta)}</strong>
              </div>
              <div className="signal-block">
                <span>duplication</span>
                <strong>{impactValue(suggestion.impact.duplicationDelta)}</strong>
              </div>
              <div className="signal-block">
                <span>coupling</span>
                <strong>{impactValue(suggestion.impact.couplingDelta)}</strong>
              </div>
            </div>

            {suggestion.simulation ? (
              <div className="refactor-columns">
                <div className="refactor-column">
                  <div className="eyebrow">Simulation Before</div>
                  <div className="refactor-list">
                    <div className="refactor-chip">entropy {suggestion.simulation.before.entropyIndex.toFixed(1)}</div>
                    <div className="refactor-chip">pressure {suggestion.simulation.before.pressureIndex.toFixed(1)}</div>
                    <div className="refactor-chip">duplication {suggestion.simulation.before.duplicationIndex.toFixed(1)}</div>
                    <div className="refactor-chip">coupling {suggestion.simulation.before.couplingIndex.toFixed(1)}</div>
                  </div>
                </div>
                <div className="refactor-column">
                  <div className="eyebrow">Simulation After</div>
                  <div className="refactor-list">
                    <div className="refactor-chip">entropy {suggestion.simulation.after.entropyIndex.toFixed(1)}</div>
                    <div className="refactor-chip">pressure {suggestion.simulation.after.pressureIndex.toFixed(1)}</div>
                    <div className="refactor-chip">duplication {suggestion.simulation.after.duplicationIndex.toFixed(1)}</div>
                    <div className="refactor-chip">coupling {suggestion.simulation.after.couplingIndex.toFixed(1)}</div>
                  </div>
                  <div className="pill-row">
                    <span className="pill">{suggestion.simulation.method}</span>
                    <span className="pill">{suggestion.simulation.confidence.toFixed(2)} sim confidence</span>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="refactor-columns">
              <div className="refactor-column">
                <div className="eyebrow">Evidence</div>
                <div className="refactor-list">
                  {suggestion.evidence.topDrivers.map((driver) => (
                    <div key={driver} className="refactor-chip">{driver}</div>
                  ))}
                </div>
                <div className="pill-row">
                  {(suggestion.evidence.entities.modules ?? []).map((module) => (
                    <span className="pill" key={module}>{module}</span>
                  ))}
                  {(suggestion.evidence.entities.files ?? []).map((file) => (
                    <span className="pill" key={file}>{file}</span>
                  ))}
                  {(suggestion.evidence.entities.edgesAdded ?? []).map((edge) => (
                    <span className="pill" key={edge}>{edge}</span>
                  ))}
                </div>
              </div>

              <div className="refactor-column">
                <div className="eyebrow">Plan</div>
                <div className="refactor-step-list">
                  {suggestion.plan.map((step, index) => (
                    <div key={`${suggestion.id}-${index}`} className="refactor-step">
                      <strong>{index + 1}</strong>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
                {suggestion.simulation?.assumptions?.length ? (
                  <div className="refactor-list">
                    {suggestion.simulation.assumptions.map((assumption) => (
                      <div key={`${suggestion.id}-${assumption}`} className="refactor-chip">{assumption}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="repo-manager-actions">
              {suggestion.status === "proposed" ? (
                <>
                  <button type="button" className="switch-pill" disabled={busyId === suggestion.id} onClick={() => void handleStatusChange(suggestion.id, "accepted")}>
                    Accept
                  </button>
                  <button type="button" className="switch-pill" disabled={busyId === suggestion.id} onClick={() => void handleStatusChange(suggestion.id, "dismissed")}>
                    Dismiss
                  </button>
                </>
              ) : null}
              {suggestion.status === "accepted" ? (
                <>
                  <button type="button" className="switch-pill" disabled={busyId === suggestion.id} onClick={() => void handleStatusChange(suggestion.id, "applied")}>
                    Mark Applied
                  </button>
                  <button type="button" className="switch-pill" disabled={busyId === suggestion.id} onClick={() => void handleStatusChange(suggestion.id, "proposed")}>
                    Reopen
                  </button>
                </>
              ) : null}
              {suggestion.status === "applied" ? (
                <button type="button" className="switch-pill" disabled={busyId === suggestion.id} onClick={() => void handleStatusChange(suggestion.id, "accepted")}>
                  Reopen
                </button>
              ) : null}
              {suggestion.status === "dismissed" ? (
                <button type="button" className="switch-pill" disabled={busyId === suggestion.id} onClick={() => void handleStatusChange(suggestion.id, "proposed")}>
                  Restore
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </section>

      <PaginationControls
        page={page.page}
        totalItems={page.total}
        totalPages={page.totalPages}
        label="Refactor Suggestions"
        onPageChange={(nextPage) => void handlePageChange(nextPage)}
      />
    </main>
  );
}
