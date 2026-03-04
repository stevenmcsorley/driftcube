import { createId, deriveModuleName, type AlertRaised, type MetricPoint, type MetricsWritten } from "@driftcube/shared";
import type { Pool } from "pg";
import { assessEntropyAnomaly, assessPressureAnomaly } from "./anomaly.js";

type IncidentScope = "repo" | "module";

function trackedAlertSubject(alert: AlertRaised): { scope: IncidentScope; subjectId: string } | null {
  if (alert.type === "ENTROPY_DRIFT") {
    const moduleName = alert.evidence.module;
    if (moduleName) {
      return { scope: "module", subjectId: moduleName };
    }

    return { scope: "repo", subjectId: alert.repoId };
  }

  if (alert.type === "ARCH_PRESSURE" && alert.evidence.module) {
    return { scope: "module", subjectId: alert.evidence.module };
  }

  return null;
}

async function loadLatestSnapshot(
  pool: Pool,
  input: {
    repoId: string;
    scope: IncidentScope;
    subjectId: string;
    at?: string;
  },
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ signature: Record<string, unknown> | null }>(
    `
      SELECT signature
      FROM architecture_snapshots
      WHERE repo_id = $1
        AND scope = $2
        AND subject_id = $3
        ${input.at ? "AND at <= $4" : ""}
      ORDER BY at DESC
      LIMIT 1
    `,
    input.at
      ? [input.repoId, input.scope, input.subjectId, input.at]
      : [input.repoId, input.scope, input.subjectId],
  );

  return result.rows[0]?.signature ?? null;
}

async function incidentExists(
  pool: Pool,
  input: {
    repoId: string;
    type: "ENTROPY_DRIFT" | "ARCH_PRESSURE";
    scope: IncidentScope;
    subjectId: string;
  },
): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM incidents
      WHERE repo_id = $1
        AND type = $2
        AND scope = $3
        AND subject_id = $4
    `,
    [input.repoId, input.type, input.scope, input.subjectId],
  );

  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function storeHistoricalIncident(
  pool: Pool,
  input: {
    repoId: string;
    commitSha: string;
    at: string;
    severity: "info" | "warn" | "error";
    type: "ENTROPY_DRIFT" | "ARCH_PRESSURE";
    scope: IncidentScope;
    subjectId: string;
    title: string;
  },
): Promise<void> {
  if (await incidentExists(pool, input)) {
    return;
  }

  const openedSignature = await loadLatestSnapshot(pool, {
    repoId: input.repoId,
    scope: input.scope,
    subjectId: input.subjectId,
    at: input.at,
  });
  const currentSignature = await loadLatestSnapshot(pool, {
    repoId: input.repoId,
    scope: input.scope,
    subjectId: input.subjectId,
  });

  await pool.query(
    `
      INSERT INTO incidents (
        repo_id, incident_id, type, scope, subject_id, status, severity,
        opened_at, updated_at, closed_at, opened_sha, closed_sha,
        opened_alert_title, latest_alert_title,
        pre_signature, latest_signature, post_signature, resolution
      )
      VALUES ($1, $2, $3, $4, $5, 'closed', $6, $7, $7, $7, $8, $8, $9, $9, $10::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
    `,
    [
      input.repoId,
      createId("incident"),
      input.type,
      input.scope,
      input.subjectId,
      input.severity,
      input.at,
      input.commitSha,
      input.title,
      JSON.stringify(openedSignature ?? {}),
      JSON.stringify(currentSignature ?? openedSignature ?? {}),
      JSON.stringify({
        reason: "historical_backfill",
        currentlyActive: false,
      }),
    ],
  );
}

export async function trackIncidentForAlert(pool: Pool, alert: AlertRaised): Promise<void> {
  if (!["ENTROPY_DRIFT", "ARCH_PRESSURE"].includes(alert.type)) {
    return;
  }

  const subject = trackedAlertSubject(alert);
  if (!subject) {
    return;
  }

  const existing = await pool.query<{ incident_id: string }>(
    `
      SELECT incident_id
      FROM incidents
      WHERE repo_id = $1
        AND type = $2
        AND scope = $3
        AND subject_id = $4
        AND status = 'open'
      ORDER BY opened_at DESC
      LIMIT 1
    `,
    [alert.repoId, alert.type, subject.scope, subject.subjectId],
  );

  const signature = await loadLatestSnapshot(pool, {
    repoId: alert.repoId,
    scope: subject.scope,
    subjectId: subject.subjectId,
    at: alert.at,
  });

  if ((existing.rowCount ?? 0) > 0) {
    await pool.query(
      `
        UPDATE incidents
        SET
          updated_at = $5,
          severity = $6,
          latest_alert_title = $7,
          latest_signature = $8::jsonb
        WHERE repo_id = $1
          AND incident_id = $2
          AND type = $3
          AND status = 'open'
      `,
      [
        alert.repoId,
        existing.rows[0]?.incident_id ?? "",
        alert.type,
        subject.subjectId,
        alert.at,
        alert.severity,
        alert.title,
        JSON.stringify(signature ?? {}),
      ],
    );
    return;
  }

  await pool.query(
    `
      INSERT INTO incidents (
        repo_id, incident_id, type, scope, subject_id, status, severity,
        opened_at, updated_at, opened_sha, opened_alert_title, latest_alert_title,
        pre_signature, latest_signature
      )
      VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $7, $8, $9, $9, $10::jsonb, $10::jsonb)
    `,
    [
      alert.repoId,
      createId("incident"),
      alert.type,
      subject.scope,
      subject.subjectId,
      alert.severity,
      alert.at,
      alert.commitSha,
      alert.title,
      JSON.stringify(signature ?? {}),
    ],
  );
}

function metricSubject(metric: MetricPoint, event: MetricsWritten): { scope: IncidentScope; subjectId: string } {
  if (metric.scope === "module") {
    return { scope: "module", subjectId: metric.subjectId ?? "" };
  }

  return { scope: "repo", subjectId: event.repoId };
}

async function loadResolutionRefactor(
  pool: Pool,
  input: {
    repoId: string;
    scope: IncidentScope;
    subjectId: string;
  },
): Promise<{
  type: string;
  confidence: number;
  target: string;
  status: string;
} | null> {
  let query = "";
  let values: unknown[] = [input.repoId, input.subjectId];

  if (input.scope === "module") {
    query = `
      SELECT type, confidence, target, status
      FROM refactor_suggestions
      WHERE repo_id = $1
        AND (
          target = $2
          OR COALESCE((evidence -> 'entities' -> 'modules') ? $2, false)
        )
        AND status <> 'dismissed'
      ORDER BY
        CASE status
          WHEN 'applied' THEN 0
          WHEN 'accepted' THEN 1
          ELSE 2
        END ASC,
        confidence DESC,
        at DESC
      LIMIT 1
    `;
  } else {
    query = `
      SELECT type, confidence, target, status
      FROM refactor_suggestions
      WHERE repo_id = $1
        AND status <> 'dismissed'
      ORDER BY
        CASE status
          WHEN 'applied' THEN 0
          WHEN 'accepted' THEN 1
          ELSE 2
        END ASC,
        confidence DESC,
        at DESC
      LIMIT 1
    `;
    values = [input.repoId];
  }

  const result = await pool.query<{
    type: string;
    confidence: number;
    target: string;
    status: string;
  }>(query, values);

  if ((result.rowCount ?? 0) === 0) {
    return null;
  }

  return {
    type: String(result.rows[0]?.type ?? ""),
    confidence: Number(result.rows[0]?.confidence ?? 0),
    target: String(result.rows[0]?.target ?? input.subjectId),
    status: String(result.rows[0]?.status ?? "proposed"),
  };
}

async function closeIncidentIfRecovered(
  pool: Pool,
  input: {
    event: MetricsWritten;
    type: "ENTROPY_DRIFT" | "ARCH_PRESSURE";
    scope: IncidentScope;
    subjectId: string;
    clearThreshold: number;
    currentValue: number;
    baselineMean: number;
    baselineStddev: number;
  },
): Promise<void> {
  if (!input.subjectId) {
    return;
  }

  if (input.currentValue > input.clearThreshold) {
    return;
  }

  const openIncidents = await pool.query<{ incident_id: string }>(
    `
      SELECT incident_id
      FROM incidents
      WHERE repo_id = $1
        AND type = $2
        AND scope = $3
        AND subject_id = $4
        AND status = 'open'
      ORDER BY opened_at DESC
    `,
    [input.event.repoId, input.type, input.scope, input.subjectId],
  );

  if ((openIncidents.rowCount ?? 0) === 0) {
    return;
  }

  const signature = await loadLatestSnapshot(pool, {
    repoId: input.event.repoId,
    scope: input.scope,
    subjectId: input.subjectId,
    at: input.event.at,
  });
  const resolutionRefactor = await loadResolutionRefactor(pool, {
    repoId: input.event.repoId,
    scope: input.scope,
    subjectId: input.subjectId,
  });

  for (const row of openIncidents.rows) {
    await pool.query(
      `
        UPDATE incidents
        SET
          status = 'closed',
          updated_at = $5,
          closed_at = $5,
          closed_sha = $6,
          post_signature = $7::jsonb,
          resolution = $8::jsonb
        WHERE repo_id = $1
          AND incident_id = $2
          AND type = $3
          AND status = 'open'
      `,
      [
        input.event.repoId,
        row.incident_id,
        input.type,
        input.subjectId,
        input.event.at,
        input.event.commitSha,
        JSON.stringify(signature ?? {}),
        JSON.stringify({
          reason: "returned_to_baseline",
          clearThreshold: Number(input.clearThreshold.toFixed(2)),
          currentValue: Number(input.currentValue.toFixed(2)),
          baselineMean: Number(input.baselineMean.toFixed(2)),
          baselineStddev: Number(input.baselineStddev.toFixed(2)),
          refactorType: resolutionRefactor?.type ?? null,
          refactorConfidence: resolutionRefactor ? Number(resolutionRefactor.confidence.toFixed(2)) : null,
          refactorTarget: resolutionRefactor?.target ?? null,
          refactorStatus: resolutionRefactor?.status ?? null,
        }),
      ],
    );
  }
}

export async function reconcileIncidents(pool: Pool, event: MetricsWritten): Promise<void> {
  const entropyMetrics = event.metrics.filter((metric) =>
    (metric.scope === "repo" || metric.scope === "module") && metric.key === "code_entropy_index");
  const pressureMetrics = event.metrics.filter((metric) => metric.scope === "module" && metric.key === "pressure_index");

  for (const metric of entropyMetrics) {
    const subject = metricSubject(metric, event);
    const assessment = await assessEntropyAnomaly(pool, {
      repoId: event.repoId,
      scope: subject.scope,
      subjectId: subject.subjectId,
      at: event.at,
      currentValue: metric.value,
    });

    if (!assessment.severity) {
      await closeIncidentIfRecovered(pool, {
        event,
        type: "ENTROPY_DRIFT",
        scope: subject.scope,
        subjectId: subject.subjectId,
        clearThreshold: assessment.clearThreshold,
        currentValue: metric.value,
        baselineMean: assessment.baselineMean,
        baselineStddev: assessment.baselineStddev,
      });
    }
  }

  for (const metric of pressureMetrics) {
    const subjectId = metric.subjectId ?? "";
    if (!subjectId) {
      continue;
    }

    const assessment = await assessPressureAnomaly(pool, {
      repoId: event.repoId,
      subjectId,
      at: event.at,
      currentValue: metric.value,
    });

    if (!assessment.severity) {
      await closeIncidentIfRecovered(pool, {
        event,
        type: "ARCH_PRESSURE",
        scope: "module",
        subjectId,
        clearThreshold: assessment.clearThreshold,
        currentValue: metric.value,
        baselineMean: assessment.baselineMean,
        baselineStddev: assessment.baselineStddev,
      });
    }
  }
}

interface HistoricalAlertRow {
  repoId: string;
  sha: string;
  at: Date | string;
  severity: "info" | "warn" | "error";
  type: string;
  title: string;
  evidence: Record<string, unknown> | null;
}

function deriveHistoricalSubject(row: HistoricalAlertRow): string {
  if (typeof row.evidence?.module === "string" && row.evidence.module.length > 0) {
    return row.evidence.module;
  }

  if (typeof row.evidence?.filePath === "string" && row.evidence.filePath.length > 0) {
    return deriveModuleName(row.evidence.filePath);
  }

  if (typeof row.evidence?.symbolId === "string" && row.evidence.symbolId.length > 0) {
    return deriveModuleName(row.evidence.symbolId.split(":", 1)[0] ?? row.evidence.symbolId);
  }

  return row.repoId;
}

export async function backfillOpenIncidents(pool: Pool): Promise<void> {
  const result = await pool.query<HistoricalAlertRow>(
    `
      WITH latest_alerts AS (
        SELECT DISTINCT ON (
          repo_id,
          CASE
            WHEN type IN ('ENTROPY_DRIFT', 'SEMANTIC_DUPLICATION', 'COMPLEXITY_CREEP', 'VOLATILITY_ZONE') THEN 'ENTROPY_DRIFT'
            ELSE 'ARCH_PRESSURE'
          END,
          COALESCE(evidence ->> 'module', repo_id)
        )
          repo_id AS "repoId",
          sha,
          at,
          severity,
          type,
          title,
          evidence
        FROM alerts
        WHERE type IN (
          'ENTROPY_DRIFT',
          'ARCH_PRESSURE',
          'SEMANTIC_DUPLICATION',
          'COMPLEXITY_CREEP',
          'VOLATILITY_ZONE',
          'ARCH_VIOLATION',
          'ARCH_EMBED_DRIFT'
        )
          AND at >= NOW() - INTERVAL '14 days'
        ORDER BY
          repo_id,
          CASE
            WHEN type IN ('ENTROPY_DRIFT', 'SEMANTIC_DUPLICATION', 'COMPLEXITY_CREEP', 'VOLATILITY_ZONE') THEN 'ENTROPY_DRIFT'
            ELSE 'ARCH_PRESSURE'
          END,
          COALESCE(evidence ->> 'module', repo_id),
          at DESC
      )
      SELECT *
      FROM latest_alerts
      ORDER BY at ASC
    `,
  );

  for (const row of result.rows) {
    const subjectId = deriveHistoricalSubject(row);
    const incidentType = row.type === "ARCH_PRESSURE"
      || row.type === "ARCH_VIOLATION"
      || row.type === "ARCH_EMBED_DRIFT"
      ? "ARCH_PRESSURE"
      : "ENTROPY_DRIFT";
    const scope: IncidentScope = subjectId === row.repoId ? "repo" : "module";
    let active = false;

    if (incidentType === "ENTROPY_DRIFT") {
      const latestMetric = await pool.query<{ value: number; at: Date | string }>(
        `
          SELECT value, at
          FROM metrics
          WHERE repo_id = $1
            AND scope = $2
            AND key = 'code_entropy_index'
            AND COALESCE(subject_id, '') = $3
          ORDER BY at DESC
          LIMIT 1
        `,
        [row.repoId, scope, subjectId],
      );

      const metric = latestMetric.rows[0];
      if (!metric) {
        continue;
      }

      const assessment = await assessEntropyAnomaly(pool, {
        repoId: row.repoId,
        scope,
        subjectId,
        at: metric.at instanceof Date ? metric.at.toISOString() : new Date(String(metric.at)).toISOString(),
        currentValue: Number(metric.value),
      });

      active = Boolean(assessment.severity);
    }

    if (incidentType === "ARCH_PRESSURE") {
      const latestMetric = await pool.query<{ value: number; at: Date | string }>(
        `
          SELECT value, at
        FROM metrics
        WHERE repo_id = $1
            AND scope = $2
            AND key = 'pressure_index'
            AND COALESCE(subject_id, '') = $3
          ORDER BY at DESC
          LIMIT 1
        `,
        [row.repoId, scope, subjectId],
      );

      const metric = latestMetric.rows[0];
      if (!metric) {
        continue;
      }

      const assessment = await assessPressureAnomaly(pool, {
        repoId: row.repoId,
        subjectId,
        at: metric.at instanceof Date ? metric.at.toISOString() : new Date(String(metric.at)).toISOString(),
        currentValue: Number(metric.value),
      });

      active = Boolean(assessment.severity);
    }

    const at = row.at instanceof Date ? row.at.toISOString() : new Date(String(row.at)).toISOString();

    if (active) {
      await trackIncidentForAlert(pool, {
        schemaVersion: 1,
        repoId: row.repoId,
        commitSha: row.sha,
        at,
        severity: row.severity,
        type: incidentType,
        title: `[backfill] ${row.title}`,
        evidence: {
          module: typeof row.evidence?.module === "string" ? row.evidence.module : undefined,
          filePath: typeof row.evidence?.filePath === "string" ? row.evidence.filePath : undefined,
          symbolId: typeof row.evidence?.symbolId === "string" ? row.evidence.symbolId : undefined,
          metrics: row.evidence && typeof row.evidence.metrics === "object"
            ? row.evidence.metrics as Record<string, number>
            : undefined,
        },
        recommendation: "Backfilled from recent DriftCube alerts to seed Architecture Memory incidents.",
      });
      continue;
    }

    await storeHistoricalIncident(pool, {
      repoId: row.repoId,
      commitSha: row.sha,
      at,
      severity: row.severity,
      type: incidentType,
      scope,
      subjectId,
      title: `[historical] ${row.title}`,
    });
  }
}
