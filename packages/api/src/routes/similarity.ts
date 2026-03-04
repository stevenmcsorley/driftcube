import { createStablePointId } from "@driftcube/shared";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

interface SimilarityFeature {
  key: string;
  label: string;
  scale: number;
}

interface RepoSimilarityRow {
  repoId: string;
  name: string;
  codeEntropyIndex: number;
  pressureIndex: number;
  pressureBoundary: number;
  pressureCoupling: number;
  pressureSemantic: number;
  pressureVolatility: number;
  componentCount: number;
  alertCount: number;
  incidentCount: number;
  archSignalCount: number;
  duplicationSignalCount: number;
  volatilitySignalCount: number;
}

interface BoundarySimilarityRow {
  repoId: string;
  boundaryId: string;
  sourceModule: string;
  targetModule: string;
  pressureIndex: number;
  edgeAdded: number;
  externalTarget: number;
  sourcePressureIndex: number;
  sourceEntropyIndex: number;
  archViolationCount: number;
}

interface OutcomeRow {
  repoId: string;
  type: string;
  scope: string;
  subjectId: string;
  closedAt: string | Date | null;
  resolution: Record<string, unknown> | null;
  preSignature: Record<string, unknown> | null;
  postSignature: Record<string, unknown> | null;
}

interface SuggestionRow {
  type: string;
  confidence: number;
  target: string;
  impact: Record<string, unknown> | null;
  status: string | null;
}

let similarityCollectionsReady: Promise<void> | null = null;
const SIGNATURE_VECTOR_SIZE = 384;

const MODULE_FEATURE_CONFIG: SimilarityFeature[] = [
  { key: "moduleDependencyCount", label: "fan-out", scale: 4 },
  { key: "externalDependencyRatio", label: "external dependency ratio", scale: 0.2 },
  { key: "avgCyclomatic", label: "avg cyclomatic", scale: 4 },
  { key: "aiEditRatio", label: "AI edit ratio", scale: 0.2 },
  { key: "codeEntropyIndex", label: "entropy", scale: 14 },
  { key: "pressureIndex", label: "pressure", scale: 14 },
  { key: "edgeChurnRatio", label: "edge churn", scale: 0.25 },
];

const REPO_FEATURE_CONFIG: SimilarityFeature[] = [
  { key: "pressureIndex", label: "pressure", scale: 16 },
  { key: "codeEntropyIndex", label: "entropy", scale: 16 },
  { key: "pressureBoundary", label: "boundary pressure", scale: 16 },
  { key: "pressureCoupling", label: "coupling pressure", scale: 16 },
  { key: "pressureSemantic", label: "semantic pressure", scale: 16 },
  { key: "pressureVolatility", label: "volatility pressure", scale: 16 },
  { key: "componentCount", label: "component count", scale: 10 },
  { key: "incidentCount", label: "incident count", scale: 6 },
];

const BOUNDARY_FEATURE_CONFIG: SimilarityFeature[] = [
  { key: "pressureIndex", label: "boundary pressure", scale: 18 },
  { key: "sourcePressureIndex", label: "source pressure", scale: 18 },
  { key: "sourceEntropyIndex", label: "source entropy", scale: 18 },
  { key: "archViolationCount", label: "boundary violations", scale: 4 },
  { key: "edgeAdded", label: "recent edge adds", scale: 1 },
  { key: "externalTarget", label: "external edge ratio", scale: 1 },
];

function toPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asFeatureRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSignatureNumber(signature: Record<string, unknown> | null, path: string[]): number {
  let cursor: unknown = signature;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return 0;
    }

    cursor = (cursor as Record<string, unknown>)[key];
  }

  return toNumber(cursor);
}

function hasSignaturePath(signature: Record<string, unknown> | null, path: string[]): boolean {
  let cursor: unknown = signature;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, key)) {
      return false;
    }

    cursor = (cursor as Record<string, unknown>)[key];
  }

  return typeof cursor === "number" || typeof cursor === "string";
}

function featureDrivers(
  config: SimilarityFeature[],
  current: Record<string, unknown>,
  candidate: Record<string, unknown>,
): string[] {
  return config
    .map((feature) => {
      const currentValue = toNumber(current[feature.key]);
      const candidateValue = toNumber(candidate[feature.key]);
      const delta = Math.abs(currentValue - candidateValue);
      const closeness = 1 - Math.min(delta / feature.scale, 1);

      return {
        label: feature.label,
        currentValue,
        candidateValue,
        closeness,
      };
    })
    .sort((left, right) => right.closeness - left.closeness)
    .slice(0, 3)
    .map((entry) => `${entry.label} ${entry.currentValue.toFixed(2)} vs ${entry.candidateValue.toFixed(2)}`);
}

function weightedScore(
  config: SimilarityFeature[],
  current: Record<string, unknown>,
  candidate: Record<string, unknown>,
): number {
  if (config.length === 0) {
    return 0;
  }

  const total = config.reduce((sum, feature) => {
    const currentValue = toNumber(current[feature.key]);
    const candidateValue = toNumber(candidate[feature.key]);
    const closeness = 1 - Math.min(Math.abs(currentValue - candidateValue) / feature.scale, 1);
    return sum + closeness;
  }, 0);

  return Number((total / config.length).toFixed(3));
}

function buildFeatureVector(config: SimilarityFeature[], data: Record<string, unknown>): number[] {
  const seed = config.map((feature) => {
    const normalized = toNumber(data[feature.key]) / Math.max(feature.scale, 1);
    return Number(Math.max(0, Math.min(4, normalized)).toFixed(6));
  });

  return Array.from({ length: SIGNATURE_VECTOR_SIZE }, (_, index) => seed[index] ?? 0);
}

async function ensureSimilarityCollections(app: FastifyInstance): Promise<void> {
  if (similarityCollectionsReady) {
    return similarityCollectionsReady;
  }

  similarityCollectionsReady = (async () => {
    const definitions = [
      { name: "repo_signatures_v1", size: SIGNATURE_VECTOR_SIZE },
      { name: "boundary_signatures_v1", size: SIGNATURE_VECTOR_SIZE },
    ];

    const existing = new Set((await app.qdrant.getCollections()).collections.map((entry) => entry.name));

    for (const definition of definitions) {
      if (!existing.has(definition.name)) {
        await app.qdrant.createCollection(definition.name, {
          vectors: {
            size: definition.size,
            distance: "Cosine",
          },
        });
      }

      for (const field of ["repoId", "scope", "pattern", "sourceModule", "targetModule"]) {
        try {
          await app.qdrant.createPayloadIndex(definition.name, {
            field_name: field,
            field_schema: "keyword",
          });
        } catch {
          // Existing indexes are fine.
        }
      }
    }
  })();

  return similarityCollectionsReady;
}

function classifyRepoPattern(row: RepoSimilarityRow): { label: string; dominantSignals: string[] } {
  const signals = [
    { label: "Boundary Drift", score: row.archSignalCount + (row.pressureBoundary / 22) },
    { label: "Clone Drift", score: row.duplicationSignalCount + (row.pressureSemantic / 22) },
    { label: "Volatility Hotspot", score: row.volatilitySignalCount + (row.pressureVolatility / 22) },
  ].sort((left, right) => right.score - left.score);

  if (row.pressureIndex < 35 && row.codeEntropyIndex < 35 && row.alertCount < 3) {
    return {
      label: "Stable Core",
      dominantSignals: ["low pressure", "low entropy"],
    };
  }

  const primary = signals[0];
  const dominantSignals = signals.filter((item) => item.score > 0.5).slice(0, 2).map((item) => item.label);

  if (!primary || primary.score <= 0.5) {
    return {
      label: "Mixed Drift",
      dominantSignals: ["pressure spread", "entropy drift"],
    };
  }

  return {
    label: primary.label,
    dominantSignals: dominantSignals.length > 0 ? dominantSignals : [primary.label],
  };
}

async function loadFixes(app: FastifyInstance, input: {
  repoId: string;
  scope: "module" | "boundary" | "repo";
  subjectId: string;
}) {
  let query = "";
  let values: unknown[] = [input.repoId, input.subjectId];

  if (input.scope === "module") {
    query = `
      SELECT type, confidence, impact, target, status
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
      LIMIT 3
    `;
  } else if (input.scope === "boundary") {
    query = `
      SELECT type, confidence, impact, target, status
      FROM refactor_suggestions
      WHERE repo_id = $1
        AND (
          target = $2
          OR COALESCE((evidence -> 'entities' -> 'edgesAdded') ? $2, false)
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
      LIMIT 3
    `;
  } else {
    query = `
      SELECT type, confidence, impact, target, status
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
      LIMIT 3
    `;
    values = [input.repoId];
  }

  const result = await app.db.query<SuggestionRow>(query, values);

  return result.rows.map((row) => ({
    type: String(row.type ?? ""),
    confidence: toNumber(row.confidence),
    target: String(row.target ?? input.subjectId),
    impact: row.impact && typeof row.impact === "object" ? row.impact : {},
    status: String(row.status ?? "proposed"),
  }));
}

async function loadOutcomes(app: FastifyInstance, input: {
  repoId: string;
  scope: "module" | "boundary" | "repo";
  subjectId: string;
}) {
  let query = "";
  let values: unknown[] = [input.repoId, input.subjectId];

  if (input.scope === "module") {
    query = `
      SELECT
        i.repo_id AS "repoId",
        i.type,
        i.scope,
        i.subject_id AS "subjectId",
        i.closed_at AS "closedAt",
        i.resolution,
        i.pre_signature AS "preSignature",
        i.post_signature AS "postSignature"
      FROM incidents i
      WHERE i.repo_id = $1
        AND i.status = 'closed'
        AND i.scope = 'module'
        AND i.subject_id = $2
      ORDER BY i.closed_at DESC NULLS LAST, i.opened_at DESC
      LIMIT 3
    `;
  } else if (input.scope === "boundary") {
    query = `
      SELECT
        i.repo_id AS "repoId",
        i.type,
        i.scope,
        i.subject_id AS "subjectId",
        i.closed_at AS "closedAt",
        i.resolution,
        i.pre_signature AS "preSignature",
        i.post_signature AS "postSignature"
      FROM incidents i
      WHERE i.repo_id = $1
        AND i.status = 'closed'
        AND i.scope = 'module'
        AND i.subject_id = split_part($2, '->', 1)
      ORDER BY i.closed_at DESC NULLS LAST, i.opened_at DESC
      LIMIT 3
    `;
  } else {
    query = `
      SELECT
        i.repo_id AS "repoId",
        i.type,
        i.scope,
        i.subject_id AS "subjectId",
        i.closed_at AS "closedAt",
        i.resolution,
        i.pre_signature AS "preSignature",
        i.post_signature AS "postSignature"
      FROM incidents i
      WHERE i.repo_id = $1
        AND i.status = 'closed'
      ORDER BY i.closed_at DESC NULLS LAST, i.opened_at DESC
      LIMIT 3
    `;
    values = [input.repoId];
  }

  const [incidents, fixes] = await Promise.all([
    app.db.query<OutcomeRow>(query, values),
    loadFixes(app, input),
  ]);

  return incidents.rows.map((row, index) => {
    const linkedFix = fixes[index] ?? fixes[0] ?? null;
    const hasEntropyFrame = hasSignaturePath(row.preSignature, ["health", "entropyIndex"])
      && hasSignaturePath(row.postSignature, ["health", "entropyIndex"]);
    const hasPressureFrame = hasSignaturePath(row.preSignature, ["health", "pressureIndex"])
      && hasSignaturePath(row.postSignature, ["health", "pressureIndex"]);
    const deltaEntropy = hasEntropyFrame
      ? Number((
        readSignatureNumber(row.postSignature, ["health", "entropyIndex"])
        - readSignatureNumber(row.preSignature, ["health", "entropyIndex"])
      ).toFixed(2))
      : 0;
    const deltaPressure = hasPressureFrame
      ? Number((
        readSignatureNumber(row.postSignature, ["health", "pressureIndex"])
        - readSignatureNumber(row.preSignature, ["health", "pressureIndex"])
      ).toFixed(2))
      : 0;
    const resolution = row.resolution && typeof row.resolution === "object" ? row.resolution : {};
    const fixType = typeof resolution.refactorType === "string"
      ? resolution.refactorType
      : linkedFix?.type ?? null;
    const fixTarget = typeof resolution.refactorTarget === "string"
      ? resolution.refactorTarget
      : linkedFix?.target ?? null;

    return {
      repoId: row.repoId,
      incidentType: row.type,
      subjectId: row.subjectId,
      closedAt: row.closedAt instanceof Date
        ? row.closedAt.toISOString()
        : String(row.closedAt ?? ""),
      deltaEntropy,
      deltaPressure,
      resolutionReason: String(resolution.reason ?? "recovered"),
      fixType,
      fixTarget,
      fixConfidence: typeof resolution.refactorConfidence === "number"
        ? Number(resolution.refactorConfidence.toFixed(2))
        : linkedFix?.confidence ?? 0,
      fixStatus: typeof resolution.refactorStatus === "string"
        ? resolution.refactorStatus
        : linkedFix?.status ?? "observed",
    };
  });
}

async function loadModuleHealth(app: FastifyInstance, repoId: string, moduleName: string) {
  const result = await app.db.query(
    `
      SELECT key, value
      FROM (
        SELECT DISTINCT ON (key)
          key,
          value,
          at
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'module'
          AND subject_id = $2
          AND key = ANY($3::text[])
        ORDER BY key, at DESC
      ) latest
    `,
    [repoId, moduleName, ["pressure_index", "code_entropy_index"]],
  );

  const values = Object.fromEntries(result.rows.map((row) => [String(row.key), toNumber(row.value)])) as Record<string, number>;
  return {
    pressureIndex: values.pressure_index ?? 0,
    codeEntropyIndex: values.code_entropy_index ?? 0,
  };
}

async function loadRepoRows(app: FastifyInstance): Promise<RepoSimilarityRow[]> {
  const result = await app.db.query<RepoSimilarityRow>(
    `
      WITH latest_repo_metric AS (
        SELECT DISTINCT ON (repo_id, key)
          repo_id,
          key,
          value
        FROM metrics
        WHERE scope = 'repo'
          AND key = ANY($1::text[])
        ORDER BY repo_id, key, at DESC
      ),
      repo_metrics AS (
        SELECT
          repo_id,
          MAX(value) FILTER (WHERE key = 'code_entropy_index') AS "codeEntropyIndex",
          MAX(value) FILTER (WHERE key = 'pressure_index') AS "pressureIndex",
          MAX(value) FILTER (WHERE key = 'pressure_boundary') AS "pressureBoundary",
          MAX(value) FILTER (WHERE key = 'pressure_coupling') AS "pressureCoupling",
          MAX(value) FILTER (WHERE key = 'pressure_semantic') AS "pressureSemantic",
          MAX(value) FILTER (WHERE key = 'pressure_volatility') AS "pressureVolatility"
        FROM latest_repo_metric
        GROUP BY repo_id
      ),
      component_counts AS (
        SELECT repo_id, COUNT(DISTINCT subject_id)::int AS "componentCount"
        FROM metrics
        WHERE scope = 'module'
          AND key = 'pressure_index'
        GROUP BY repo_id
      ),
      alert_counts AS (
        SELECT
          repo_id,
          COUNT(*)::int AS "alertCount",
          COUNT(*) FILTER (WHERE type IN ('ARCH_PRESSURE', 'ARCH_VIOLATION', 'ARCH_EMBED_DRIFT'))::int AS "archSignalCount",
          COUNT(*) FILTER (WHERE type = 'SEMANTIC_DUPLICATION')::int AS "duplicationSignalCount",
          COUNT(*) FILTER (WHERE type = 'VOLATILITY_ZONE')::int AS "volatilitySignalCount"
        FROM alerts
        WHERE at >= NOW() - INTERVAL '7 days'
        GROUP BY repo_id
      ),
      incident_counts AS (
        SELECT repo_id, COUNT(*)::int AS "incidentCount"
        FROM incidents
        WHERE opened_at >= NOW() - INTERVAL '14 days'
        GROUP BY repo_id
      )
      SELECT
        r.repo_id AS "repoId",
        r.name,
        COALESCE(m."codeEntropyIndex", 0) AS "codeEntropyIndex",
        COALESCE(m."pressureIndex", 0) AS "pressureIndex",
        COALESCE(m."pressureBoundary", 0) AS "pressureBoundary",
        COALESCE(m."pressureCoupling", 0) AS "pressureCoupling",
        COALESCE(m."pressureSemantic", 0) AS "pressureSemantic",
        COALESCE(m."pressureVolatility", 0) AS "pressureVolatility",
        COALESCE(c."componentCount", 0) AS "componentCount",
        COALESCE(a."alertCount", 0) AS "alertCount",
        COALESCE(i."incidentCount", 0) AS "incidentCount",
        COALESCE(a."archSignalCount", 0) AS "archSignalCount",
        COALESCE(a."duplicationSignalCount", 0) AS "duplicationSignalCount",
        COALESCE(a."volatilitySignalCount", 0) AS "volatilitySignalCount"
      FROM repos r
      LEFT JOIN repo_metrics m ON m.repo_id = r.repo_id
      LEFT JOIN component_counts c ON c.repo_id = r.repo_id
      LEFT JOIN alert_counts a ON a.repo_id = r.repo_id
      LEFT JOIN incident_counts i ON i.repo_id = r.repo_id
      ORDER BY r.repo_id ASC
    `,
    [[
      "code_entropy_index",
      "pressure_index",
      "pressure_boundary",
      "pressure_coupling",
      "pressure_semantic",
      "pressure_volatility",
    ]],
  );

  return result.rows.map((row) => ({
    ...row,
    codeEntropyIndex: toNumber(row.codeEntropyIndex),
    pressureIndex: toNumber(row.pressureIndex),
    pressureBoundary: toNumber(row.pressureBoundary),
    pressureCoupling: toNumber(row.pressureCoupling),
    pressureSemantic: toNumber(row.pressureSemantic),
    pressureVolatility: toNumber(row.pressureVolatility),
    componentCount: toNumber(row.componentCount),
    alertCount: toNumber(row.alertCount),
    incidentCount: toNumber(row.incidentCount),
    archSignalCount: toNumber(row.archSignalCount),
    duplicationSignalCount: toNumber(row.duplicationSignalCount),
    volatilitySignalCount: toNumber(row.volatilitySignalCount),
  }));
}

async function loadBoundaryRows(app: FastifyInstance): Promise<BoundarySimilarityRow[]> {
  const result = await app.db.query<BoundarySimilarityRow>(
    `
      WITH latest_boundary AS (
        SELECT DISTINCT ON (repo_id, subject_id)
          repo_id,
          subject_id,
          value,
          tags
        FROM metrics
        WHERE scope = 'boundary'
          AND key = 'pressure_index'
        ORDER BY repo_id, subject_id, at DESC
      ),
      latest_module AS (
        SELECT DISTINCT ON (repo_id, subject_id, key)
          repo_id,
          subject_id,
          key,
          value
        FROM metrics
        WHERE scope = 'module'
          AND key = ANY($1::text[])
        ORDER BY repo_id, subject_id, key, at DESC
      ),
      module_metrics AS (
        SELECT
          repo_id,
          subject_id,
          MAX(value) FILTER (WHERE key = 'pressure_index') AS pressure_index,
          MAX(value) FILTER (WHERE key = 'code_entropy_index') AS entropy_index
        FROM latest_module
        GROUP BY repo_id, subject_id
      ),
      boundary_alerts AS (
        SELECT
          repo_id,
          edge,
          COUNT(*)::int AS arch_violation_count
        FROM (
          SELECT
            repo_id,
            jsonb_array_elements_text(COALESCE(evidence -> 'graphEdgesAdded', '[]'::jsonb)) AS edge
          FROM alerts
          WHERE type = 'ARCH_VIOLATION'
            AND at >= NOW() - INTERVAL '7 days'
        ) expanded
        GROUP BY repo_id, edge
      )
      SELECT
        b.repo_id AS "repoId",
        b.subject_id AS "boundaryId",
        COALESCE(b.tags ->> 'sourceModule', split_part(b.subject_id, '->', 1)) AS "sourceModule",
        COALESCE(b.tags ->> 'targetModule', split_part(b.subject_id, '->', 2)) AS "targetModule",
        COALESCE(b.value, 0) AS "pressureIndex",
        COALESCE((b.tags ->> 'edgeAdded')::double precision, 0) AS "edgeAdded",
        COALESCE((b.tags ->> 'externalTarget')::double precision, 0) AS "externalTarget",
        COALESCE(m.pressure_index, 0) AS "sourcePressureIndex",
        COALESCE(m.entropy_index, 0) AS "sourceEntropyIndex",
        COALESCE(a.arch_violation_count, 0) AS "archViolationCount"
      FROM latest_boundary b
      LEFT JOIN module_metrics m
        ON m.repo_id = b.repo_id
       AND m.subject_id = COALESCE(b.tags ->> 'sourceModule', split_part(b.subject_id, '->', 1))
      LEFT JOIN boundary_alerts a
        ON a.repo_id = b.repo_id
       AND a.edge = b.subject_id
      ORDER BY b.repo_id ASC, b.subject_id ASC
    `,
    [["pressure_index", "code_entropy_index"]],
  );

  return result.rows.map((row) => ({
    ...row,
    pressureIndex: toNumber(row.pressureIndex),
    edgeAdded: toNumber(row.edgeAdded),
    externalTarget: toNumber(row.externalTarget),
    sourcePressureIndex: toNumber(row.sourcePressureIndex),
    sourceEntropyIndex: toNumber(row.sourceEntropyIndex),
    archViolationCount: toNumber(row.archViolationCount),
  }));
}

export async function registerSimilarityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/components/:componentId/similar", async (request) => {
    const params = z.object({
      repoId: z.string(),
      componentId: z.string(),
    }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().min(1).max(20).default(6),
    }).parse(request.query);

    const moduleId = `${params.repoId}:${params.componentId}`;
    const pointId = createStablePointId(moduleId);
    const currentPoint = (await app.qdrant.retrieve("modules_v1", {
      ids: [pointId],
      with_payload: true,
      with_vector: true,
    }))[0];

    if (!currentPoint) {
      return {
        repoId: params.repoId,
        componentId: params.componentId,
        role: null,
        items: [],
      };
    }

    const currentPayload = toPayload(currentPoint.payload);
    const currentVector = Array.isArray(currentPoint.vector)
      ? currentPoint.vector.filter((value): value is number => typeof value === "number")
      : [];

    if (currentVector.length === 0) {
      return {
        repoId: params.repoId,
        componentId: params.componentId,
        role: String(currentPayload.role ?? ""),
        items: [],
      };
    }

    const results = await app.qdrant.search("modules_v1", {
      vector: currentVector,
      limit: query.limit + 8,
      with_payload: true,
    });

    const candidates = results
      .filter((entry) => String(entry.payload?.moduleId ?? "") !== moduleId)
      .sort((left, right) => {
        const leftSameRole = String(left.payload?.role ?? "") === String(currentPayload.role ?? "");
        const rightSameRole = String(right.payload?.role ?? "") === String(currentPayload.role ?? "");

        if (leftSameRole !== rightSameRole) {
          return rightSameRole ? 1 : -1;
        }

        return (right.score ?? 0) - (left.score ?? 0);
      })
      .slice(0, query.limit);

    const currentHealth = await loadModuleHealth(app, params.repoId, params.componentId);
    currentPayload.pressureIndex = currentHealth.pressureIndex;
    currentPayload.codeEntropyIndex = currentHealth.codeEntropyIndex;

    const items = await Promise.all(candidates.map(async (entry) => {
      const payload = toPayload(entry.payload);
      const candidateRepoId = String(payload.repoId ?? "");
      const candidateModule = String(payload.module ?? "root");
      const [fixes, outcomes, health] = await Promise.all([
        loadFixes(app, { repoId: candidateRepoId, scope: "module", subjectId: candidateModule }),
        loadOutcomes(app, { repoId: candidateRepoId, scope: "module", subjectId: candidateModule }),
        loadModuleHealth(app, candidateRepoId, candidateModule),
      ]);
      payload.pressureIndex = health.pressureIndex;
      payload.codeEntropyIndex = health.codeEntropyIndex;

      return {
        repoId: candidateRepoId,
        moduleId: candidateModule,
        moduleKey: String(payload.moduleId ?? `${candidateRepoId}:${candidateModule}`),
        role: String(payload.role ?? ""),
        score: Number((entry.score ?? 0).toFixed(3)),
        drivers: featureDrivers(MODULE_FEATURE_CONFIG, currentPayload, payload),
        metrics: {
          pressureIndex: toNumber(payload.pressureIndex),
          codeEntropyIndex: toNumber(payload.codeEntropyIndex),
          moduleDependencyCount: toNumber(payload.moduleDependencyCount),
          aiEditRatio: toNumber(payload.aiEditRatio),
        },
        fixes,
        outcomes,
      };
    }));

    return {
      repoId: params.repoId,
      componentId: params.componentId,
      role: String(currentPayload.role ?? ""),
      items,
    };
  });

  app.get("/repos/:repoId/similar", async (request) => {
    const params = z.object({
      repoId: z.string(),
    }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().min(1).max(20).default(5),
    }).parse(request.query);

    const repoRows = await loadRepoRows(app);
    const current = repoRows.find((row) => row.repoId === params.repoId);
    if (!current) {
      return {
        repoId: params.repoId,
        items: [],
      };
    }

    await ensureSimilarityCollections(app);
    const currentPoint = (await app.qdrant.retrieve("repo_signatures_v1", {
      ids: [createStablePointId(`repo:${params.repoId}`)],
      with_payload: true,
      with_vector: true,
    }))[0];

    const repoSearch = currentPoint && Array.isArray(currentPoint.vector)
      ? await app.qdrant.search("repo_signatures_v1", {
        vector: currentPoint.vector.filter((value): value is number => typeof value === "number"),
        limit: query.limit + 8,
        with_payload: true,
      })
      : [];

    const items = await Promise.all(
      (repoSearch.length > 0
        ? repoSearch
          .filter((entry) => String(entry.payload?.repoId ?? "") !== params.repoId)
          .slice(0, query.limit)
        : repoRows
          .filter((row) => row.repoId !== params.repoId)
          .map((row) => ({
            payload: { repoId: row.repoId },
            score: weightedScore(REPO_FEATURE_CONFIG, asFeatureRecord(current), asFeatureRecord(row)),
          }))
          .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
          .slice(0, query.limit))
        .map(async (entry) => {
          const candidate = repoRows.find((row) => row.repoId === String(entry.payload?.repoId ?? ""));
          if (!candidate) {
            return null;
          }
          const fixes = await loadFixes(app, { repoId: candidate.repoId, scope: "repo", subjectId: candidate.repoId });
          const outcomes = await loadOutcomes(app, { repoId: candidate.repoId, scope: "repo", subjectId: candidate.repoId });
          const pattern = classifyRepoPattern(candidate);

          return {
            repoId: candidate.repoId,
            name: candidate.name,
            score: Number((entry.score ?? weightedScore(REPO_FEATURE_CONFIG, asFeatureRecord(current), asFeatureRecord(candidate))).toFixed(3)),
            drivers: featureDrivers(REPO_FEATURE_CONFIG, asFeatureRecord(current), asFeatureRecord(candidate)),
            metrics: {
              pressureIndex: candidate.pressureIndex,
              codeEntropyIndex: candidate.codeEntropyIndex,
              componentCount: candidate.componentCount,
              incidentCount: candidate.incidentCount,
              alertCount: candidate.alertCount,
            },
            pattern: pattern.label,
            dominantSignals: pattern.dominantSignals,
            fixes,
            outcomes,
          };
        }),
    );

    return {
      repoId: params.repoId,
      items: items.filter((item): item is NonNullable<typeof item> => Boolean(item)),
    };
  });

  app.get("/repos/:repoId/boundaries/similar", async (request) => {
    const params = z.object({
      repoId: z.string(),
    }).parse(request.params);
    const query = z.object({
      boundaryId: z.string().optional(),
      limit: z.coerce.number().min(1).max(20).default(5),
    }).parse(request.query);

    const boundaryRows = await loadBoundaryRows(app);
    const current = query.boundaryId
      ? boundaryRows.find((row) => row.repoId === params.repoId && row.boundaryId === query.boundaryId)
      : boundaryRows
        .filter((row) => row.repoId === params.repoId)
        .sort((left, right) => right.pressureIndex - left.pressureIndex)[0];

    if (!current) {
      return {
        repoId: params.repoId,
        boundaryId: query.boundaryId ?? null,
        items: [],
      };
    }

    await ensureSimilarityCollections(app);
    const currentPoint = (await app.qdrant.retrieve("boundary_signatures_v1", {
      ids: [createStablePointId(`boundary:${current.repoId}:${current.boundaryId}`)],
      with_payload: true,
      with_vector: true,
    }))[0];
    const boundarySearch = currentPoint && Array.isArray(currentPoint.vector)
      ? await app.qdrant.search("boundary_signatures_v1", {
        vector: currentPoint.vector.filter((value): value is number => typeof value === "number"),
        limit: query.limit + 10,
        with_payload: true,
      })
      : [];

    const items = await Promise.all(
      (boundarySearch.length > 0
        ? boundarySearch
          .filter((entry) => !(
            String(entry.payload?.repoId ?? "") === current.repoId
            && String(entry.payload?.boundaryId ?? "") === current.boundaryId
          ))
          .slice(0, query.limit)
        : boundaryRows
          .filter((row) => !(row.repoId === current.repoId && row.boundaryId === current.boundaryId))
          .map((row) => ({
            payload: { repoId: row.repoId, boundaryId: row.boundaryId },
            score: weightedScore(BOUNDARY_FEATURE_CONFIG, asFeatureRecord(current), asFeatureRecord(row)),
          }))
          .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
          .slice(0, query.limit))
        .map(async (entry) => {
          const candidate = boundaryRows.find((row) => (
            row.repoId === String(entry.payload?.repoId ?? "")
            && row.boundaryId === String(entry.payload?.boundaryId ?? "")
          ));
          if (!candidate) {
            return null;
          }
          const fixes = await loadFixes(app, { repoId: candidate.repoId, scope: "boundary", subjectId: candidate.boundaryId });
          const outcomes = await loadOutcomes(app, { repoId: candidate.repoId, scope: "boundary", subjectId: candidate.boundaryId });
          const score = (entry.score ?? weightedScore(BOUNDARY_FEATURE_CONFIG, asFeatureRecord(current), asFeatureRecord(candidate)))
            + (candidate.targetModule === current.targetModule ? 0.08 : 0)
            + (candidate.externalTarget === current.externalTarget ? 0.04 : 0);

          return {
            repoId: candidate.repoId,
            boundaryId: candidate.boundaryId,
            sourceModule: candidate.sourceModule,
            targetModule: candidate.targetModule,
            score,
            drivers: featureDrivers(BOUNDARY_FEATURE_CONFIG, asFeatureRecord(current), asFeatureRecord(candidate)),
            metrics: {
              pressureIndex: candidate.pressureIndex,
              sourcePressureIndex: candidate.sourcePressureIndex,
              sourceEntropyIndex: candidate.sourceEntropyIndex,
              archViolationCount: candidate.archViolationCount,
            },
            fixes,
            outcomes,
          };
        }),
    );

    return {
      repoId: params.repoId,
      boundaryId: current.boundaryId,
      items: items
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((left, right) => right.score - left.score)
        .map((item) => ({
          ...item,
          score: Number(item.score.toFixed(3)),
        })),
    };
  });
}
