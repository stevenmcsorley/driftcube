import { getCommit } from "../../../lib/api";

export default async function CommitPage({
  params,
  searchParams,
}: {
  params: Promise<{ sha: string }>;
  searchParams: Promise<{ repoId?: string }>;
}) {
  const { sha } = await params;
  const query = await searchParams;
  const repoId = query.repoId ?? "";
  const commit = repoId ? await getCommit(repoId, sha) : null;
  const alerts = Array.isArray(commit?.alerts) ? commit.alerts : [];
  const errorCount = alerts.filter((alert) => String((alert as Record<string, unknown>).severity ?? "") === "error").length;
  const warnCount = alerts.filter((alert) => String((alert as Record<string, unknown>).severity ?? "") === "warn").length;

  return (
    <main className="stack">
      <section className="hero">
        <div className="eyebrow">Commit</div>
        <h1>{sha}</h1>
        <p>{String(commit?.message ?? "Local or synthetic commit event.")}</p>
        <div className="grid cards">
          <div className="panel">
            <div className="eyebrow">Findings</div>
            <strong>{alerts.length}</strong>
            <p className="muted">Signals attached to this commit event.</p>
          </div>
          <div className="panel">
            <div className="eyebrow">Critical</div>
            <strong>{errorCount}</strong>
            <p className="muted">Error-grade drift or architecture breaks.</p>
          </div>
          <div className="panel">
            <div className="eyebrow">Warnings</div>
            <strong>{warnCount}</strong>
            <p className="muted">Non-blocking findings that still need review.</p>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="eyebrow">Gate Report</div>
        <div className="alert-list" style={{ marginTop: 16 }}>
          {alerts.length === 0 ? <p className="muted">No alerts recorded for this commit.</p> : null}
          {alerts.map((alert) => (
            <div key={`${String((alert as Record<string, unknown>).at)}-${String((alert as Record<string, unknown>).title)}`} className="alert-card">
              <div className="alert-card-top">
                <div className={`severity-badge status-${String((alert as Record<string, unknown>).severity ?? "info").toLowerCase()}`}>
                  {String((alert as Record<string, unknown>).type ?? "unknown")}
                </div>
                <span className="muted">{String((alert as Record<string, unknown>).at ?? "")}</span>
              </div>
              <div className="repo-visual-meter">
                <span className={`status-${String((alert as Record<string, unknown>).severity ?? "info").toLowerCase()}`} style={{ width: `${String((alert as Record<string, unknown>).severity ?? "info") === "error" ? 100 : 60}%` }} />
              </div>
              <div>{String((alert as Record<string, unknown>).title ?? "")}</div>
              <div className="muted">{String((alert as Record<string, unknown>).recommendation ?? "")}</div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
