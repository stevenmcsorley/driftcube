import type { QdrantClient } from "@qdrant/js-client-rest";
import { createStablePointId, type AlertRaised, type GraphUpdated, type Severity } from "@driftcube/shared";
import type { Pool } from "pg";

interface ModuleSnapshotMetrics {
  fileCount: number;
  symbolCount: number;
  avgCyclomatic: number;
  maxCyclomatic: number;
  avgNesting: number;
  maxLines: number;
  avgAiRisk: number;
  aiEditRatio: number;
  codeEntropyIndex: number;
  pressureIndex: number;
  moduleDependencyCount: number;
  externalDependencyCount: number;
  edgeAdditions: number;
  edgeRemovals: number;
  edgeChurnRatio: number;
  dependencyPerFile: number;
  externalDependencyRatio: number;
}

const FEATURE_KEYS = [
  "fileCount",
  "symbolCount",
  "avgCyclomatic",
  "maxCyclomatic",
  "avgNesting",
  "maxLines",
  "avgAiRisk",
  "aiEditRatio",
  "moduleDependencyCount",
  "externalDependencyCount",
  "edgeAdditions",
  "edgeRemovals",
  "edgeChurnRatio",
  "dependencyPerFile",
  "externalDependencyRatio",
] as const;

const FEATURE_SCALES: Record<(typeof FEATURE_KEYS)[number], number> = {
  fileCount: 1,
  symbolCount: 8,
  avgCyclomatic: 3,
  maxCyclomatic: 4,
  avgNesting: 2,
  maxLines: 25,
  avgAiRisk: 12,
  aiEditRatio: 0.2,
  moduleDependencyCount: 1,
  externalDependencyCount: 1,
  edgeAdditions: 1,
  edgeRemovals: 1,
  edgeChurnRatio: 0.2,
  dependencyPerFile: 1,
  externalDependencyRatio: 0.25,
};

const WARN_DISTANCE = 0.18;
const ERROR_DISTANCE = 0.28;
const DEFAULT_VECTOR_SIZE = 384;

let cachedVectorSize: number | null = null;

function asDenseVector(vector: unknown): number[] {
  if (Array.isArray(vector) && vector.every((item) => typeof item === "number")) {
    return vector as number[];
  }

  if (Array.isArray(vector) && Array.isArray(vector[0])) {
    const first = vector[0];
    return Array.isArray(first) ? first.filter((item): item is number => typeof item === "number") : [];
  }

  return [];
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function limitRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function inferModuleRole(moduleName: string, filePath: string): string {
  const loweredModule = moduleName.toLowerCase();
  const loweredPath = filePath.toLowerCase();

  if (loweredModule.includes("web") || loweredPath.includes("/controller") || loweredPath.includes("/route")) {
    return "edge";
  }

  if (loweredModule.includes("infra") || loweredModule.includes("adapter") || loweredPath.includes("/adapter")) {
    return "adapter";
  }

  if (loweredPath.includes("gateway") || loweredPath.includes("client")) {
    return "gateway";
  }

  if (loweredModule.includes("util") || loweredModule.includes("shared")) {
    return "utility";
  }

  return "core";
}

function buildMetrics(
  snapshot: Omit<ModuleSnapshotMetrics, "moduleDependencyCount" | "externalDependencyCount" | "edgeAdditions" | "edgeRemovals" | "edgeChurnRatio" | "dependencyPerFile" | "externalDependencyRatio">,
  event: GraphUpdated,
): ModuleSnapshotMetrics {
  const moduleDependencyCount = Math.max(0, Number(event.moduleDependencyCount ?? event.graphEdgesCurrent?.length ?? 0));
  const externalDependencyCount = Math.max(0, Number(event.externalDependencyCount ?? 0));
  const edgeAdditions = event.graphEdgesAdded?.length ?? 0;
  const edgeRemovals = event.graphEdgesRemoved?.length ?? 0;
  const edgeChurnRatio = (edgeAdditions + edgeRemovals) / Math.max(moduleDependencyCount, 1);
  const dependencyPerFile = moduleDependencyCount / Math.max(snapshot.fileCount, 1);
  const externalDependencyRatio = externalDependencyCount / Math.max(moduleDependencyCount, 1);

  return {
    ...snapshot,
    aiEditRatio: limitRatio(snapshot.aiEditRatio),
    moduleDependencyCount,
    externalDependencyCount,
    edgeAdditions,
    edgeRemovals,
    edgeChurnRatio,
    dependencyPerFile,
    externalDependencyRatio,
  };
}

function buildVector(metrics: ModuleSnapshotMetrics, vectorSize: number): number[] {
  const seed = [
    Math.log1p(metrics.fileCount),
    Math.log1p(metrics.symbolCount),
    metrics.avgCyclomatic / 20,
    metrics.maxCyclomatic / 40,
    metrics.avgNesting / 10,
    Math.log1p(metrics.maxLines) / 6,
    metrics.avgAiRisk / 100,
    metrics.aiEditRatio,
    Math.log1p(metrics.moduleDependencyCount) / 4,
    Math.log1p(metrics.externalDependencyCount) / 4,
    Math.log1p(metrics.edgeAdditions) / 3,
    Math.log1p(metrics.edgeRemovals) / 3,
    limitRatio(metrics.edgeChurnRatio),
    Math.min(metrics.dependencyPerFile / 8, 1),
    limitRatio(metrics.externalDependencyRatio),
    metrics.codeEntropyIndex / 100,
    metrics.pressureIndex / 100,
  ];

  return Array.from({ length: vectorSize }, (_, index) => seed[index] ?? 0);
}

function cosineDistance(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  const similarity = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return 1 - Math.max(-1, Math.min(1, similarity));
}

function severityFor(distance: number, aiEditRatio: number): Severity | null {
  if (distance >= ERROR_DISTANCE || (distance >= 0.22 && aiEditRatio >= 0.6)) {
    return "error";
  }

  if (distance >= WARN_DISTANCE) {
    return "warn";
  }

  return null;
}

function featureValueFromPayload(payload: Record<string, unknown>, key: (typeof FEATURE_KEYS)[number]): number {
  return toNumber(payload[key]);
}

function collectDeltas(current: ModuleSnapshotMetrics, previous: Record<string, unknown>) {
  return FEATURE_KEYS.map((key) => ({
    key,
    delta: toNumber(current[key]) - featureValueFromPayload(previous, key),
    normalized: Math.min(Math.abs(toNumber(current[key]) - featureValueFromPayload(previous, key)) / FEATURE_SCALES[key], 1.5),
  }));
}

function topDeltas(current: ModuleSnapshotMetrics, previous: Record<string, unknown>): Record<string, number> {
  const changes = collectDeltas(current, previous)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 4);

  return Object.fromEntries(changes.map((change) => [`delta_${change.key}`, Number(change.delta.toFixed(4))]));
}

function driftScore(current: ModuleSnapshotMetrics, previous: Record<string, unknown>, distance: number): number {
  const normalizedTopChanges = collectDeltas(current, previous)
    .sort((left, right) => right.normalized - left.normalized)
    .slice(0, 4);

  if (normalizedTopChanges.length === 0) {
    return distance;
  }

  const deltaSignal = normalizedTopChanges.reduce((sum, change) => sum + change.normalized, 0)
    / normalizedTopChanges.length;
  return distance + deltaSignal;
}

async function resolveVectorSize(qdrant: QdrantClient): Promise<number> {
  if (cachedVectorSize) {
    return cachedVectorSize;
  }

  try {
    const collection = await qdrant.getCollection("modules_v1");
    const vectors = collection.config?.params?.vectors;
    if (vectors && typeof vectors === "object" && "size" in vectors && typeof vectors.size === "number") {
      cachedVectorSize = vectors.size;
      return cachedVectorSize;
    }
  } catch {
    // Fall back to the shared embed size if collection metadata is not available yet.
  }

  cachedVectorSize = DEFAULT_VECTOR_SIZE;
  return cachedVectorSize;
}

async function loadModuleSnapshot(pool: Pool, repoId: string, moduleName: string): Promise<ModuleSnapshotMetrics> {
  const result = await pool.query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (subject_id, key)
          subject_id,
          key,
          value,
          tags,
          at
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'symbol'
          AND tags ->> 'module' = $2
        ORDER BY subject_id, key, at DESC
      )
      SELECT
        COUNT(DISTINCT tags ->> 'filePath') AS file_count,
        COUNT(DISTINCT subject_id) FILTER (WHERE subject_id <> '') AS symbol_count,
        AVG(value) FILTER (WHERE key = 'cyclomatic') AS avg_cyclomatic,
        MAX(value) FILTER (WHERE key = 'cyclomatic') AS max_cyclomatic,
        AVG(value) FILTER (WHERE key = 'nesting_depth') AS avg_nesting,
        MAX(value) FILTER (WHERE key = 'line_count') AS max_lines,
        AVG(value) FILTER (WHERE key = 'ai_risk_score') AS avg_ai_risk,
        AVG(
          CASE
            WHEN COALESCE(tags ->> 'provenance', 'unknown') IN ('human', 'unknown') THEN 0
            ELSE 1
          END
        ) FILTER (WHERE key = 'ai_risk_score') AS ai_edit_ratio
      FROM latest
    `,
    [repoId, moduleName],
  );

  const latestModuleMetrics = await pool.query(
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
    [repoId, moduleName, ["code_entropy_index", "pressure_index"]],
  );

  const row = result.rows[0] ?? {};
  const moduleMetricValues = Object.fromEntries(
    latestModuleMetrics.rows.map((entry) => [String(entry.key), toNumber(entry.value)]),
  ) as Record<string, number>;

  return buildMetrics(
    {
      fileCount: toNumber(row.file_count),
      symbolCount: toNumber(row.symbol_count),
      avgCyclomatic: toNumber(row.avg_cyclomatic),
      maxCyclomatic: toNumber(row.max_cyclomatic),
      avgNesting: toNumber(row.avg_nesting),
      maxLines: toNumber(row.max_lines),
      avgAiRisk: toNumber(row.avg_ai_risk),
      aiEditRatio: toNumber(row.ai_edit_ratio),
      codeEntropyIndex: toNumber(moduleMetricValues.code_entropy_index),
      pressureIndex: toNumber(moduleMetricValues.pressure_index),
    },
    {
      schemaVersion: 1,
      repoId,
      commitSha: "",
      filePath: "",
      moduleName,
      moduleDependencyCount: 0,
      externalDependencyCount: 0,
      graphEdgesAdded: [],
      graphEdgesRemoved: [],
      graphEdgesCurrent: [],
      symbols: [],
    },
  );
}

export async function detectArchitectureEmbeddingDrift(
  pool: Pool,
  qdrant: QdrantClient,
  event: GraphUpdated,
): Promise<AlertRaised[]> {
  const moduleName = event.moduleName ?? "root";
  const moduleId = `${event.repoId}:${moduleName}`;
  const pointId = createStablePointId(moduleId);
  const snapshotBase = await loadModuleSnapshot(pool, event.repoId, moduleName);
  const snapshot = buildMetrics(snapshotBase, event);
  const vectorSize = await resolveVectorSize(qdrant);
  const vector = buildVector(snapshot, vectorSize);

  const previous = (await qdrant.retrieve("modules_v1", {
    ids: [pointId],
    with_vector: true,
    with_payload: true,
  }))[0];

  const neighbours = await qdrant.search("modules_v1", {
    vector,
    limit: 4,
    with_payload: true,
    filter: {
      must: [
        { key: "repoId", match: { value: event.repoId } },
      ],
      must_not: [
        { key: "moduleId", match: { value: moduleId } },
      ],
    },
  });

  await qdrant.upsert("modules_v1", {
    wait: true,
    points: [
      {
        id: pointId,
        vector,
        payload: {
          repoId: event.repoId,
          commitSha: event.commitSha,
          module: moduleName,
          moduleId,
          role: inferModuleRole(moduleName, event.filePath),
          filePath: event.filePath,
          ...snapshot,
          graphEdgesCurrent: event.graphEdgesCurrent ?? [],
          updatedAt: new Date().toISOString(),
        },
      },
    ],
  });

  const previousPayload = (typeof previous?.payload === "object" && previous.payload !== null)
    ? (previous.payload as Record<string, unknown>)
    : {};
  const previousVector = asDenseVector(previous?.vector);
  if (previousVector.length === 0) {
    return [];
  }

  const distance = cosineDistance(previousVector, vector);
  const compositeScore = driftScore(snapshot, previousPayload, distance);
  const severity = severityFor(distance, snapshot.aiEditRatio)
    ?? (compositeScore >= 0.95 || (compositeScore >= 0.75 && snapshot.aiEditRatio >= 0.6)
      ? "error"
      : compositeScore >= 0.55
        ? "warn"
        : null);
  if (!severity) {
    return [];
  }

  return [
    {
      schemaVersion: 1,
      repoId: event.repoId,
      commitSha: event.commitSha,
      at: new Date().toISOString(),
      severity,
      type: "ARCH_EMBED_DRIFT",
      title: `Architecture drift detected in ${moduleName}`,
      evidence: {
        filePath: event.filePath,
        module: moduleName,
        neighbours: neighbours.map((item) => ({
          id: String(item.payload?.module ?? item.id),
          score: item.score,
        })),
        graphEdgesAdded: event.graphEdgesAdded ?? [],
        graphEdgesRemoved: event.graphEdgesRemoved ?? [],
        metrics: {
          architecture_distance: Number(distance.toFixed(4)),
          architecture_drift_score: Number(compositeScore.toFixed(4)),
          file_count: snapshot.fileCount,
          symbol_count: snapshot.symbolCount,
          avg_cyclomatic: Number(snapshot.avgCyclomatic.toFixed(2)),
          avg_ai_risk: Number(snapshot.avgAiRisk.toFixed(2)),
          ai_edit_ratio: Number(snapshot.aiEditRatio.toFixed(4)),
          code_entropy_index: Number(snapshot.codeEntropyIndex.toFixed(2)),
          pressure_index: Number(snapshot.pressureIndex.toFixed(2)),
          module_dependency_count: snapshot.moduleDependencyCount,
          external_dependency_count: snapshot.externalDependencyCount,
          edge_churn_ratio: Number(snapshot.edgeChurnRatio.toFixed(4)),
          ...topDeltas(snapshot, previousPayload),
        },
      },
      recommendation: "Review the module boundary shape and recent edge churn before this architecture drift hardens into the baseline.",
    },
  ];
}
