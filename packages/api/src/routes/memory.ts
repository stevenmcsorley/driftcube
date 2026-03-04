import { z } from "zod";
import type { FastifyInstance } from "fastify";

type SignatureRecord = Record<string, unknown>;

interface SnapshotRow {
  sha: string;
  at: Date | string;
  signature: SignatureRecord | null;
}

interface IncidentRow {
  incidentId: string;
  type: string;
  scope: string;
  subjectId: string;
  status: string;
  severity: string;
  openedAt: Date | string;
  updatedAt: Date | string;
  closedAt: Date | string | null;
  openedAlertTitle: string | null;
  latestAlertTitle: string | null;
  preSignature: SignatureRecord | null;
  latestSignature: SignatureRecord | null;
  postSignature: SignatureRecord | null;
  resolution: SignatureRecord | null;
}

function toObject(value: unknown): SignatureRecord {
  return value && typeof value === "object" ? value as SignatureRecord : {};
}

function readNumber(record: SignatureRecord, path: string[], fallback = 0): number {
  let current: unknown = record;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return fallback;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  const parsed = Number(current ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function buildFrame(row: SnapshotRow | null, strategy?: string | null) {
  if (!row) {
    return null;
  }

  const signature = toObject(row.signature);
  return {
    sha: String(row.sha ?? ""),
    at: asIsoString(row.at),
    strategy: strategy ?? undefined,
    signature,
    health: {
      entropyIndex: readNumber(signature, ["health", "entropyIndex"]),
      pressureIndex: readNumber(signature, ["health", "pressureIndex"]),
      duplicationEntropy: readNumber(signature, ["health", "duplicationEntropy"]),
      architectureEntropy: readNumber(signature, ["health", "architectureEntropy"]),
    },
    graph: {
      archViolations: readNumber(signature, ["graph", "archViolations"]),
      moduleCount: readNumber(signature, ["graph", "moduleCount"]),
      boundaryCount: readNumber(signature, ["graph", "boundaryCount"]),
      moduleDependencyCount: readNumber(signature, ["graph", "moduleDependencyCount"]),
      externalDependencyCount: readNumber(signature, ["graph", "externalDependencyCount"]),
    },
    complexity: {
      avgCyclomatic: readNumber(signature, ["complexity", "avgCyclomatic"]),
      maxCyclomatic: readNumber(signature, ["complexity", "maxCyclomatic"]),
    },
    semantic: {
      aiEditRatio: readNumber(signature, ["semantic", "aiEditRatio"]),
      duplicationAlerts: readNumber(signature, ["semantic", "duplicationAlerts"]),
      symbolCount: readNumber(signature, ["semantic", "symbolCount"]),
    },
    volatility: {
      churn24h: readNumber(signature, ["volatility", "churn24h"]),
      volatilityAlerts: readNumber(signature, ["volatility", "volatilityAlerts"]),
    },
  };
}

function buildDelta(current: ReturnType<typeof buildFrame>, baseline: ReturnType<typeof buildFrame>) {
  if (!current || !baseline) {
    return null;
  }

  return {
    entropyIndex: Number((current.health.entropyIndex - baseline.health.entropyIndex).toFixed(2)),
    pressureIndex: Number((current.health.pressureIndex - baseline.health.pressureIndex).toFixed(2)),
    avgCyclomatic: Number((current.complexity.avgCyclomatic - baseline.complexity.avgCyclomatic).toFixed(2)),
    aiEditRatio: Number((current.semantic.aiEditRatio - baseline.semantic.aiEditRatio).toFixed(4)),
    duplicationAlerts: Number((current.semantic.duplicationAlerts - baseline.semantic.duplicationAlerts).toFixed(2)),
    archViolations: Number((current.graph.archViolations - baseline.graph.archViolations).toFixed(2)),
    churn24h: Number((current.volatility.churn24h - baseline.volatility.churn24h).toFixed(2)),
  };
}

function buildIncidentFrame(signature: SignatureRecord | null, at: Date | string | null, strategy: string) {
  if (!signature || !at) {
    return null;
  }

  return buildFrame({
    sha: "",
    at,
    signature,
  }, strategy);
}

function modulePosture(current: ReturnType<typeof buildFrame>, delta: ReturnType<typeof buildDelta>): "stable" | "warming" | "pressured" | "critical" {
  if (!current) {
    return "stable";
  }

  const pressure = current.health.pressureIndex;
  const entropy = current.health.entropyIndex;
  const deltaPressure = delta?.pressureIndex ?? 0;
  const deltaEntropy = delta?.entropyIndex ?? 0;

  if (pressure >= 80 || entropy >= 80 || deltaPressure >= 20 || deltaEntropy >= 20) {
    return "critical";
  }

  if (pressure >= 60 || entropy >= 60 || deltaPressure >= 10 || deltaEntropy >= 10) {
    return "pressured";
  }

  if (pressure >= 35 || entropy >= 40 || deltaPressure >= 5 || deltaEntropy >= 5) {
    return "warming";
  }

  return "stable";
}

async function buildMemoryPayload(app: FastifyInstance, repoId: string) {
  const currentResult = await app.db.query<SnapshotRow>(
    `
      SELECT sha, at, signature
      FROM architecture_snapshots
      WHERE repo_id = $1
        AND scope = 'repo'
      ORDER BY at DESC
      LIMIT 1
    `,
    [repoId],
  );

  const currentRow = currentResult.rows[0] ?? null;
  if (!currentRow) {
    return {
      repoId,
      current: null,
      baseline: null,
      delta: null,
      modules: [],
      timeline: [],
      incidents: [],
      generatedAt: new Date().toISOString(),
    };
  }

  let baselineResult = await app.db.query<SnapshotRow & { strategy: string }>(
    `
      SELECT sha, at, signature, 'latest_healthy' AS strategy
      FROM architecture_snapshots
      WHERE repo_id = $1
        AND scope = 'repo'
        AND COALESCE((signature -> 'health' ->> 'entropyIndex')::double precision, 0) <= 45
        AND COALESCE((signature -> 'health' ->> 'pressureIndex')::double precision, 0) <= 45
      ORDER BY at DESC
      LIMIT 1
    `,
    [repoId],
  );

  if ((baselineResult.rowCount ?? 0) === 0) {
    baselineResult = await app.db.query<SnapshotRow & { strategy: string }>(
      `
        SELECT sha, at, signature, 'best_recent' AS strategy
        FROM architecture_snapshots
        WHERE repo_id = $1
          AND scope = 'repo'
        ORDER BY
          COALESCE((signature -> 'health' ->> 'entropyIndex')::double precision, 0)
          + COALESCE((signature -> 'health' ->> 'pressureIndex')::double precision, 0)
          + (COALESCE((signature -> 'graph' ->> 'archViolations')::double precision, 0) * 20)
          ASC,
          at DESC
        LIMIT 1
      `,
      [repoId],
    );
  }

  const baselineRow = baselineResult.rows[0] ?? null;
  const current = buildFrame(currentRow);
  const rawBaseline = buildFrame(baselineRow, baselineRow?.strategy ?? null);
  const baseline = rawBaseline && rawBaseline.sha === current?.sha && rawBaseline.at === current?.at
    ? null
    : rawBaseline;
  const delta = buildDelta(current, baseline);
  const baselineAt = baseline?.at ?? null;

  const moduleRows = await app.db.query<SnapshotRow & { moduleId: string }>(
    `
      WITH latest_module AS (
        SELECT DISTINCT ON (subject_id)
          subject_id,
          sha,
          at,
          signature
        FROM architecture_snapshots
        WHERE repo_id = $1
          AND scope = 'module'
        ORDER BY subject_id, at DESC
      )
      SELECT
        subject_id AS "moduleId",
        sha,
        at,
        signature
      FROM latest_module
      ORDER BY
        (COALESCE((signature -> 'health' ->> 'pressureIndex')::double precision, 0) * 1.25) +
        (COALESCE((signature -> 'health' ->> 'entropyIndex')::double precision, 0) * 0.85) +
        (COALESCE((signature -> 'graph' ->> 'archViolations')::double precision, 0) * 18)
        DESC,
        subject_id ASC
      LIMIT 8
    `,
    [repoId],
  );

  const modules = await Promise.all(
    moduleRows.rows.map(async (row) => {
      const baselineModuleResult = await app.db.query<SnapshotRow>(
        `
          SELECT sha, at, signature
          FROM architecture_snapshots
          WHERE repo_id = $1
            AND scope = 'module'
            AND subject_id = $2
            AND at <= $3
          ORDER BY at DESC
          LIMIT 1
        `,
        [repoId, row.moduleId, baselineAt],
      );

      const currentModule = buildFrame(row);
      const baselineModule = baselineAt
        ? buildFrame(baselineModuleResult.rows[0] ?? null)
        : null;
      const moduleDelta = buildDelta(currentModule, baselineModule);

      return {
        moduleId: row.moduleId,
        current: currentModule,
        baseline: baselineModule,
        delta: moduleDelta,
        posture: modulePosture(currentModule, moduleDelta),
      };
    }),
  );

  const timelineRows = await app.db.query<
    SnapshotRow & {
      entropy_index: number;
      pressure_index: number;
      arch_violations: number;
      ai_edit_ratio: number;
      incident_count: number;
    }
  >(
    `
      SELECT
        s.sha,
        s.at,
        s.signature,
        COALESCE((s.signature -> 'health' ->> 'entropyIndex')::double precision, 0) AS entropy_index,
        COALESCE((s.signature -> 'health' ->> 'pressureIndex')::double precision, 0) AS pressure_index,
        COALESCE((s.signature -> 'graph' ->> 'archViolations')::double precision, 0) AS arch_violations,
        COALESCE((s.signature -> 'semantic' ->> 'aiEditRatio')::double precision, 0) AS ai_edit_ratio,
        COALESCE((
          SELECT COUNT(*)
          FROM incidents i
          WHERE i.repo_id = s.repo_id
            AND i.opened_at <= s.at
            AND (i.closed_at IS NULL OR i.closed_at >= s.at)
        ), 0) AS incident_count
      FROM architecture_snapshots s
      WHERE s.repo_id = $1
        AND s.scope = 'repo'
      ORDER BY s.at DESC
      LIMIT 18
    `,
    [repoId],
  );

  const incidents = await app.db.query<IncidentRow>(
    `
      SELECT
        incident_id AS "incidentId",
        type,
        scope,
        subject_id AS "subjectId",
        status,
        severity,
        opened_at AS "openedAt",
        updated_at AS "updatedAt",
        closed_at AS "closedAt",
        opened_alert_title AS "openedAlertTitle",
        latest_alert_title AS "latestAlertTitle",
        pre_signature AS "preSignature",
        latest_signature AS "latestSignature",
        post_signature AS "postSignature",
        resolution
      FROM incidents
      WHERE repo_id = $1
      ORDER BY opened_at DESC
      LIMIT 10
    `,
    [repoId],
  );

  return {
    repoId,
    current,
    baseline,
    delta,
    modules,
    timeline: timelineRows.rows.map((row) => ({
      sha: String(row.sha ?? ""),
      at: asIsoString(row.at),
      entropyIndex: readNumber(toObject(row.signature), ["health", "entropyIndex"]),
      pressureIndex: readNumber(toObject(row.signature), ["health", "pressureIndex"]),
      archViolations: Number(row.arch_violations ?? 0),
      aiEditRatio: Number(row.ai_edit_ratio ?? 0),
      incidentCount: Number(row.incident_count ?? 0),
    })).reverse(),
    incidents: incidents.rows.map((row) => {
      const opened = buildIncidentFrame(row.preSignature, row.openedAt, "opened");
      const latest = buildIncidentFrame(row.latestSignature, row.updatedAt, "latest");
      const recovered = buildIncidentFrame(row.postSignature, row.closedAt, "recovered");

      return {
        incidentId: row.incidentId,
        type: row.type,
        scope: row.scope,
        subjectId: row.subjectId,
        status: row.status,
        severity: row.severity,
        openedAt: asIsoString(row.openedAt),
        closedAt: row.closedAt ? asIsoString(row.closedAt) : null,
        openedAlertTitle: row.openedAlertTitle,
        latestAlertTitle: row.latestAlertTitle,
        resolution: toObject(row.resolution),
        frames: {
          opened,
          latest,
          recovered,
        },
        deltas: {
          openedToLatest: buildDelta(latest, opened),
          openedToRecovered: buildDelta(recovered, opened),
        },
      };
    }),
    generatedAt: new Date().toISOString(),
  };
}

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/memory", async (request) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    return buildMemoryPayload(app, params.repoId);
  });

  app.get("/repos/:repoId/memory/events", async (request, reply) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "*";

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": origin,
      vary: "Origin",
    });

    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ repoId: params.repoId, ts: new Date().toISOString() })}\n\n`);

    const listener = (payload: Record<string, unknown>) => {
      reply.raw.write(`event: memory.refresh\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    }, 15000);

    app.memoryEvents.on(`repo:${params.repoId}`, listener);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      app.memoryEvents.off(`repo:${params.repoId}`, listener);
      reply.raw.end();
    });
  });
}
