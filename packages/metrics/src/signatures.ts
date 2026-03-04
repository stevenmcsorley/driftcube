import { createStablePointId } from "@driftcube/shared";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Pool } from "pg";

interface SimilarityFeature {
  key: string;
  scale: number;
}

interface RepoSignatureRow {
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

interface BoundarySignatureRow {
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

const SIGNATURE_VECTOR_SIZE = Number(process.env.EMBED_VECTOR_SIZE ?? "384");

const REPO_FEATURE_CONFIG: SimilarityFeature[] = [
  { key: "pressureIndex", scale: 16 },
  { key: "codeEntropyIndex", scale: 16 },
  { key: "pressureBoundary", scale: 16 },
  { key: "pressureCoupling", scale: 16 },
  { key: "pressureSemantic", scale: 16 },
  { key: "pressureVolatility", scale: 16 },
  { key: "componentCount", scale: 10 },
  { key: "incidentCount", scale: 6 },
];

const BOUNDARY_FEATURE_CONFIG: SimilarityFeature[] = [
  { key: "pressureIndex", scale: 18 },
  { key: "sourcePressureIndex", scale: 18 },
  { key: "sourceEntropyIndex", scale: 18 },
  { key: "archViolationCount", scale: 4 },
  { key: "edgeAdded", scale: 1 },
  { key: "externalTarget", scale: 1 },
];

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildFeatureVector(config: SimilarityFeature[], data: Record<string, unknown>): number[] {
  const seed = config.map((feature) => {
    const normalized = toNumber(data[feature.key]) / Math.max(feature.scale, 1);
    return Number(Math.max(0, Math.min(4, normalized)).toFixed(6));
  });

  return Array.from({ length: SIGNATURE_VECTOR_SIZE }, (_, index) => seed[index] ?? 0);
}

function classifyRepoPattern(row: RepoSignatureRow): { label: string; dominantSignals: string[] } {
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

async function ensureSignatureCollections(qdrant: QdrantClient): Promise<void> {
  const existing = new Set((await qdrant.getCollections()).collections.map((entry) => entry.name));
  for (const name of ["repo_signatures_v1", "boundary_signatures_v1"]) {
    if (!existing.has(name)) {
      await qdrant.createCollection(name, {
        vectors: {
          size: SIGNATURE_VECTOR_SIZE,
          distance: "Cosine",
        },
      });
    }

    for (const field of ["repoId", "scope", "pattern", "sourceModule", "targetModule"]) {
      try {
        await qdrant.createPayloadIndex(name, {
          field_name: field,
          field_schema: "keyword",
        });
      } catch {
        // Existing index is acceptable.
      }
    }
  }
}

async function loadRepoRow(pool: Pool, repoId: string): Promise<RepoSignatureRow | null> {
  const result = await pool.query<RepoSignatureRow>(
    `
      WITH latest_repo_metric AS (
        SELECT DISTINCT ON (repo_id, key)
          repo_id,
          key,
          value
        FROM metrics
        WHERE scope = 'repo'
          AND repo_id = $1
          AND key = ANY($2::text[])
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
        WHERE repo_id = $1
          AND scope = 'module'
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
        WHERE repo_id = $1
          AND at >= NOW() - INTERVAL '7 days'
        GROUP BY repo_id
      ),
      incident_counts AS (
        SELECT repo_id, COUNT(*)::int AS "incidentCount"
        FROM incidents
        WHERE repo_id = $1
          AND opened_at >= NOW() - INTERVAL '14 days'
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
      WHERE r.repo_id = $1
      LIMIT 1
    `,
    [repoId, [
      "code_entropy_index",
      "pressure_index",
      "pressure_boundary",
      "pressure_coupling",
      "pressure_semantic",
      "pressure_volatility",
    ]],
  );

  const row = result.rows[0];
  return row ? {
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
  } : null;
}

async function loadBoundaryRows(pool: Pool, repoId: string): Promise<BoundarySignatureRow[]> {
  const result = await pool.query<BoundarySignatureRow>(
    `
      WITH latest_boundary AS (
        SELECT DISTINCT ON (repo_id, subject_id)
          repo_id,
          subject_id,
          value,
          tags
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'boundary'
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
        WHERE repo_id = $1
          AND scope = 'module'
          AND key = ANY($2::text[])
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
          WHERE repo_id = $1
            AND type = 'ARCH_VIOLATION'
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
      ORDER BY b.subject_id ASC
    `,
    [repoId, ["pressure_index", "code_entropy_index"]],
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

export async function writeSimilaritySignatures(pool: Pool, qdrant: QdrantClient, repoId: string): Promise<void> {
  await ensureSignatureCollections(qdrant);
  const [repoRow, boundaryRows] = await Promise.all([
    loadRepoRow(pool, repoId),
    loadBoundaryRows(pool, repoId),
  ]);

  if (repoRow) {
    const pattern = classifyRepoPattern(repoRow);
    await qdrant.upsert("repo_signatures_v1", {
      wait: false,
      points: [{
        id: createStablePointId(`repo:${repoRow.repoId}`),
        vector: buildFeatureVector(REPO_FEATURE_CONFIG, repoRow as unknown as Record<string, unknown>),
        payload: {
          ...repoRow,
          repoId: repoRow.repoId,
          scope: "repo",
          name: repoRow.name,
          pattern: pattern.label,
        },
      }],
    });
  }

  if (boundaryRows.length > 0) {
    await qdrant.upsert("boundary_signatures_v1", {
      wait: false,
      points: boundaryRows.map((row) => ({
        id: createStablePointId(`boundary:${row.repoId}:${row.boundaryId}`),
        vector: buildFeatureVector(BOUNDARY_FEATURE_CONFIG, row as unknown as Record<string, unknown>),
        payload: {
          ...row,
          repoId: row.repoId,
          scope: "boundary",
          boundaryId: row.boundaryId,
          sourceModule: row.sourceModule,
          targetModule: row.targetModule,
        },
      })),
    });
  }
}
