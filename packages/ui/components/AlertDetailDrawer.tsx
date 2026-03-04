"use client";

import Link from "next/link";
import { useState } from "react";
import { createAlertComment, linkAlertRefactor, updateAlertStatus, type AlertDetail } from "../lib/api";

function severityTone(severity: string | null | undefined): string {
  if (severity === "error") return "status-error";
  if (severity === "warn") return "status-warn";
  return "status-healthy";
}

function signalLabel(type: string, heuristicCategory?: string): string {
  if (type === "CONTENT_HEURISTIC" && heuristicCategory) {
    return heuristicCategory.replaceAll("_", " ");
  }

  return type.replaceAll("_", " ");
}

function alertStatusTone(status: string | null | undefined): string {
  if (status === "resolved") return "status-healthy";
  if (status === "acknowledged") return "status-warn";
  return "status-error";
}

function shortDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AlertDetailDrawer(props: {
  repoId: string;
  detail: AlertDetail | null;
  loading: boolean;
  error?: string | null;
  onClose?: () => void;
  onCommentAdded?: () => void;
}) {
  const detail = props.detail;
  const [commentBody, setCommentBody] = useState("");
  const [commentKind, setCommentKind] = useState<"note" | "fix" | "improvement">("note");
  const [commentAuthor, setCommentAuthor] = useState("operator");
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<"inline" | "split">("inline");
  const [linkingRefactorId, setLinkingRefactorId] = useState<string | null>(null);
  const [statusActor, setStatusActor] = useState("operator");
  const [statusBusy, setStatusBusy] = useState<"open" | "acknowledged" | "resolved" | null>(null);

  async function handleSubmit() {
    if (!detail || !commentBody.trim()) {
      return;
    }

    setCommentSaving(true);
    setCommentError(null);
    try {
      await createAlertComment(props.repoId, detail.alert.id, {
        kind: commentKind,
        author: commentAuthor.trim() || "operator",
        body: commentBody.trim(),
      });
      setCommentBody("");
      props.onCommentAdded?.();
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : "Unable to save note.");
    } finally {
      setCommentSaving(false);
    }
  }

  async function handleLinkRefactor(refactorId: string) {
    if (!detail) {
      return;
    }

    setLinkingRefactorId(refactorId);
    setCommentError(null);
    try {
      await linkAlertRefactor(props.repoId, detail.alert.id, {
        refactorId,
        linkedBy: commentAuthor.trim() || "operator",
      });
      props.onCommentAdded?.();
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : "Unable to link refactor.");
    } finally {
      setLinkingRefactorId(null);
    }
  }

  async function handleStatusChange(status: "open" | "acknowledged" | "resolved") {
    if (!detail) {
      return;
    }

    setStatusBusy(status);
    setCommentError(null);
    try {
      await updateAlertStatus(props.repoId, detail.alert.id, {
        status,
        actor: statusActor.trim() || "operator",
      });
      props.onCommentAdded?.();
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : "Unable to update alert status.");
    } finally {
      setStatusBusy(null);
    }
  }

  const splitDiffRows = detail?.diff.lines.reduce<Array<{
    before: string;
    after: string;
    kind: "context" | "change" | "meta";
  }>>((rows, line, index, items) => {
    if (line.kind === "meta") {
      rows.push({ before: line.text, after: line.text, kind: "meta" });
      return rows;
    }

    if (line.kind === "remove") {
      const next = items[index + 1];
      if (next?.kind === "add") {
        rows.push({ before: line.text, after: next.text, kind: "change" });
      } else {
        rows.push({ before: line.text, after: "", kind: "change" });
      }
      return rows;
    }

    if (line.kind === "add") {
      const prev = items[index - 1];
      if (prev?.kind === "remove") {
        return rows;
      }
      rows.push({ before: "", after: line.text, kind: "change" });
      return rows;
    }

    rows.push({ before: line.text, after: line.text, kind: "context" });
    return rows;
  }, []);

  return (
    <aside className="panel alert-detail-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Alert Evidence</div>
          <h2 className="panel-title">Code Proof</h2>
        </div>
        {props.onClose ? (
          <button type="button" className="switch-pill" onClick={props.onClose}>
            close
          </button>
        ) : null}
      </div>

      {props.loading ? <p className="muted">Loading alert evidence…</p> : null}
      {!props.loading && props.error ? <p className="muted">{props.error}</p> : null}
      {!props.loading && !props.error && !detail ? (
        <p className="muted">Select an alert to inspect the file, recent notes, and linked fixes.</p>
      ) : null}

      {detail ? (
        <div className="alert-detail-stack">
          <div className="alert-detail-summary">
            <div className="pill-row">
              <span className={`severity-badge ${severityTone(detail.alert.severity)}`}>
                {signalLabel(detail.alert.type, typeof detail.alert.evidence?.heuristicCategory === "string" ? detail.alert.evidence.heuristicCategory : undefined)}
              </span>
              <span className={`status-chip ${alertStatusTone(detail.alert.status)}`}>{detail.alert.status ?? "open"}</span>
              <span className="pill">{shortDateTime(detail.alert.at)}</span>
              {detail.alert.sha ? <span className="pill">sha {detail.alert.sha.slice(0, 8)}</span> : null}
            </div>
            <h3 className="alert-detail-title">{detail.alert.title}</h3>
            {detail.alert.recommendation ? <p className="muted">{detail.alert.recommendation}</p> : null}
            <div className="pill-row alert-summary-tags">
              {typeof detail.alert.evidence?.filePath === "string" ? <span className="pill">{detail.alert.evidence.filePath}</span> : null}
              {typeof detail.alert.evidence?.module === "string" ? <span className="pill">{detail.alert.evidence.module}</span> : null}
              {typeof detail.alert.evidence?.symbolId === "string" ? <span className="pill">{detail.alert.evidence.symbolId}</span> : null}
            </div>
            <div className="alert-workflow-row">
              <div className="alert-workflow-input">
                <input
                  className="surface-input surface-input-compact"
                  value={statusActor}
                  onChange={(event) => setStatusActor(event.target.value)}
                  placeholder="operator"
                />
              </div>
              <div className="pill-row alert-workflow-actions">
                <button
                  type="button"
                  className={`switch-pill${detail.alert.status === "open" ? " switch-pill-active" : ""}`}
                  disabled={statusBusy !== null}
                  onClick={() => void handleStatusChange("open")}
                >
                  {statusBusy === "open" ? "Saving..." : "Reopen"}
                </button>
                <button
                  type="button"
                  className={`switch-pill${detail.alert.status === "acknowledged" ? " switch-pill-active" : ""}`}
                  disabled={statusBusy !== null}
                  onClick={() => void handleStatusChange("acknowledged")}
                >
                  {statusBusy === "acknowledged" ? "Saving..." : "Acknowledge"}
                </button>
                <button
                  type="button"
                  className={`switch-pill${detail.alert.status === "resolved" ? " switch-pill-active" : ""}`}
                  disabled={statusBusy !== null}
                  onClick={() => void handleStatusChange("resolved")}
                >
                  {statusBusy === "resolved" ? "Saving..." : "Resolve"}
                </button>
              </div>
            </div>
            {detail.alert.acknowledgedAt || detail.alert.acknowledgedBy || detail.alert.resolvedAt || detail.alert.resolvedBy ? (
              <div className="alert-summary-meta muted">
                {detail.alert.acknowledgedAt ? <span>ack {shortDateTime(detail.alert.acknowledgedAt)}</span> : null}
                {detail.alert.acknowledgedBy ? <span>by {detail.alert.acknowledgedBy}</span> : null}
                {detail.alert.resolvedAt ? <span>resolved {shortDateTime(detail.alert.resolvedAt)}</span> : null}
                {detail.alert.resolvedBy ? <span>by {detail.alert.resolvedBy}</span> : null}
              </div>
            ) : null}
          </div>

          <section className="alert-proof-block">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">File Preview</div>
                <h3 className="panel-title">Evidence Snippet</h3>
              </div>
              {detail.preview.available ? (
                <div className="pill">
                  lines {detail.preview.previewStart}-{detail.preview.previewEnd} / {detail.preview.totalLines}
                </div>
              ) : null}
            </div>
            {detail.preview.available ? (
              <div className="code-proof">
                {detail.preview.lines.map((line) => (
                  <div key={`${line.number}-${line.text}`} className={`code-line${line.highlight ? " code-line-highlight" : ""}`}>
                    <span className="code-line-no">{line.number}</span>
                    <code>{line.text || " "}</code>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">{detail.preview.reason ?? "No mounted file preview available."}</p>
            )}
          </section>

          <section className="alert-proof-block">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Inline Diff</div>
                <h3 className="panel-title">Current Change</h3>
              </div>
              <div className="pill-row">
                <button
                  type="button"
                  className={`switch-pill${diffMode === "inline" ? " switch-pill-active" : ""}`}
                  onClick={() => setDiffMode("inline")}
                >
                  inline
                </button>
                <button
                  type="button"
                  className={`switch-pill${diffMode === "split" ? " switch-pill-active" : ""}`}
                  onClick={() => setDiffMode("split")}
                >
                  side by side
                </button>
              </div>
            </div>
            {detail.diff.available ? (
              diffMode === "inline" ? (
                <div className="code-proof">
                  {detail.diff.lines.map((line, index) => (
                    <div key={`${line.kind}-${index}-${line.text}`} className={`code-line code-line-${line.kind}`}>
                      <span className="code-line-no">
                        {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : line.kind === "meta" ? "@" : " "}
                      </span>
                      <code>{line.text}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="split-diff">
                  <div className="split-diff-head">
                    <span>Before</span>
                    <span>After</span>
                  </div>
                  {splitDiffRows?.map((row, index) => (
                    <div key={`${row.kind}-${index}-${row.before}-${row.after}`} className={`split-diff-row split-diff-row-${row.kind}`}>
                      <code>{row.before || " "}</code>
                      <code>{row.after || " "}</code>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <p className="muted">{detail.diff.reason ?? "No inline diff is available for this file."}</p>
            )}
          </section>

          <section className="alert-proof-block">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Surface Notes</div>
                <h3 className="panel-title">Recent Remarks</h3>
              </div>
              <div className="pill">{detail.activityHistory.length} updates</div>
            </div>
            <div className="note-timeline">
              {detail.activityHistory.length === 0 ? <p className="muted">No file-level remarks were recorded for this alert yet.</p> : null}
              {detail.activityHistory.map((item) => (
                <div key={item.eventId} className="note-card">
                  <div className="note-card-top">
                    <span className="pill">{item.parserStatus}</span>
                    <span className="muted">{new Date(item.at).toLocaleString()}</span>
                  </div>
                  <strong>{item.filePath}</strong>
                  <p className="muted">{item.note ?? "Watched live."}</p>
                  <div className="pill-row">
                    <span className="pill">{item.changeType}</span>
                    <span className="pill">{item.language ?? "unknown"}</span>
                    {item.provenance && item.provenance !== "unknown" ? <span className="pill">{item.provenance}</span> : null}
                    <span className="pill">{item.symbolCount} symbols</span>
                    <span className="pill">{item.alertCount} alerts</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="alert-proof-block">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Operator Notes</div>
                <h3 className="panel-title">Thread</h3>
              </div>
              <div className="pill">{detail.comments.length} notes</div>
            </div>

            <div className="note-compose">
              <div className="pill-row">
                <input
                  className="surface-input"
                  value={commentAuthor}
                  onChange={(event) => setCommentAuthor(event.target.value)}
                  placeholder="author"
                />
                <select
                  className="surface-input surface-select"
                  value={commentKind}
                  onChange={(event) => setCommentKind(event.target.value as "note" | "fix" | "improvement")}
                >
                  <option value="note">note</option>
                  <option value="fix">fix</option>
                  <option value="improvement">improvement</option>
                </select>
              </div>
              <textarea
                className="surface-textarea"
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                placeholder="Add an operator note, fix decision, or improvement follow-up…"
              />
              <div className="pill-row">
                <button type="button" className="switch-pill switch-pill-active" onClick={() => void handleSubmit()} disabled={commentSaving}>
                  {commentSaving ? "saving" : "add note"}
                </button>
                {commentError ? <span className="muted">{commentError}</span> : null}
              </div>
            </div>

            <div className="note-timeline">
              {detail.comments.length === 0 ? <p className="muted">No operator notes have been saved for this alert yet.</p> : null}
              {detail.comments.map((comment) => (
                <div key={comment.id} className="note-card">
                  <div className="note-card-top">
                    <span className="severity-badge status-healthy">{comment.kind}</span>
                    <span className="muted">{new Date(comment.createdAt).toLocaleString()}</span>
                  </div>
                  <strong>{comment.author}</strong>
                  <p className="muted">{comment.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="alert-proof-block">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Fixes</div>
                <h3 className="panel-title">Linked Improvements</h3>
              </div>
              <Link href={`/repos/${encodeURIComponent(props.repoId)}/refactors`} className="pill">
                open refactors
              </Link>
            </div>
            <div className="refactor-list-stack">
              {detail.relatedRefactors.length === 0 ? <p className="muted">No linked fixes were found for this alert yet.</p> : null}
              {detail.relatedRefactors.map((refactor) => (
                <div key={refactor.id} className="note-card">
                  <div className="note-card-top">
                    <span className="severity-badge status-healthy">{refactor.type.replaceAll("_", " ")}</span>
                    <span className="pill">{refactor.status ?? "proposed"}</span>
                  </div>
                  <strong>{refactor.target}</strong>
                  <div className="pill-row">
                    <span className="pill">{(refactor.confidence * 100).toFixed(0)}% confidence</span>
                    {typeof refactor.impact.pressureDelta === "number" ? <span className="pill">pressure {refactor.impact.pressureDelta.toFixed(2)}</span> : null}
                    {typeof refactor.impact.entropyDelta === "number" ? <span className="pill">entropy {refactor.impact.entropyDelta.toFixed(2)}</span> : null}
                    {refactor.linkedToAlert ? <span className="pill pill-added">linked</span> : null}
                  </div>
                  <div className="refactor-list">
                    {refactor.plan.slice(0, 4).map((step) => (
                      <div key={`${refactor.id}-${step}`} className="refactor-chip">{step}</div>
                    ))}
                  </div>
                  {!refactor.linkedToAlert ? (
                    <div className="pill-row">
                      <button
                        type="button"
                        className="switch-pill"
                        disabled={linkingRefactorId === refactor.id}
                        onClick={() => void handleLinkRefactor(refactor.id)}
                      >
                        {linkingRefactorId === refactor.id ? "linking" : "link to alert"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section className="alert-proof-block">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">Related Signals</div>
                <h3 className="panel-title">Same File</h3>
              </div>
            </div>
            <div className="note-timeline">
              {detail.relatedAlerts.length === 0 ? <p className="muted">No other recent alerts were found on this file.</p> : null}
              {detail.relatedAlerts.map((alert) => (
                <div key={alert.id} className="note-card">
                  <div className="note-card-top">
                    <span className={`severity-badge ${severityTone(alert.severity)}`}>
                      {signalLabel(alert.type, typeof alert.evidence?.heuristicCategory === "string" ? alert.evidence.heuristicCategory : undefined)}
                    </span>
                    <span className="muted">{new Date(alert.at).toLocaleString()}</span>
                  </div>
                  <strong>{alert.title}</strong>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
