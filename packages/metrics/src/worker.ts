import {
  Subjects,
  deriveModuleName,
  publishJson,
  subscribeJson,
  type AlertRaised,
  type GraphUpdated,
  type MetricsWritten,
  type SymbolsExtracted,
} from "@driftcube/shared";
import { createLogger } from "@driftcube/shared";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { NatsConnection } from "nats";
import type { Pool } from "pg";
import { findAiSmells } from "./calc/aiSmells.js";
import {
  computeArchitectureEntropy,
  computeChangeEntropy,
  computeCodeEntropyIndex,
  computeComplexityEntropy,
  computeDependencyEntropy,
  computeDuplicationEntropy,
} from "./calc/entropy.js";
import {
  computeArchitecturePressureComponents,
  computeArchitecturePressureIndex,
  computeBoundaryPressureIndex,
} from "./calc/pressure.js";
import { estimateCyclomaticComplexity, estimateNestingDepth, countLines } from "./calc/complexity.js";
import { computeAiRiskScore } from "./calc/driftScores.js";
import { writeSimilaritySignatures } from "./signatures.js";
import { buildMetric, insertMetrics } from "./timeseries.js";

const logger = createLogger("metrics");
const entropyRefreshes = new Map<string, number>();
const architectureSnapshotRefreshes = new Map<string, number>();
const signatureRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

interface ModuleMetricInputs {
  fileCount: number;
  symbolCount: number;
  avgCyclomatic: number;
  stddevCyclomatic: number;
  maxCyclomatic: number;
  aiEditRatio: number;
  churn24h: number;
  duplicationAlerts: number;
  archViolations: number;
  archDriftAlerts: number;
  volatilityAlerts: number;
}

interface RepoEntropyAverages {
  dependencyEntropy: number;
  duplicationEntropy: number;
  complexityEntropy: number;
  changeEntropy: number;
  architectureEntropy: number;
  codeEntropyIndex: number;
  moduleCount: number;
}

interface RepoSnapshotInputs {
  symbolCount: number;
  fileCount: number;
  avgCyclomatic: number;
  maxCyclomatic: number;
  avgAiRisk: number;
  aiEditRatio: number;
  churn24h: number;
  duplicationAlerts: number;
  archViolations: number;
  archPressureAlerts: number;
  volatilityAlerts: number;
  boundaryCount: number;
}

interface PreviousPressureState {
  previousModuleDependencyCount: number;
  previousModuleEntropyIndex: number;
  previousModulePressureIndex: number;
}

interface RepoPressureAverages {
  changePressure: number;
  couplingPressure: number;
  semanticPressure: number;
  boundaryPressure: number;
  entropyPressure: number;
  volatilityPressure: number;
  pressureIndex: number;
  moduleCount: number;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toInteger(value: unknown): number {
  return Math.max(0, Math.round(toNumber(value)));
}

function modulePathPattern(moduleName: string): string {
  if (moduleName === "root") {
    return "%";
  }

  return `src/${moduleName}/%`;
}

function moduleSymbolPattern(moduleName: string): string {
  if (moduleName === "root") {
    return "%";
  }

  return `src/${moduleName}/%`;
}

function resolveAlertModule(event: AlertRaised): string | null {
  if (typeof event.evidence.module === "string" && event.evidence.module.length > 0) {
    return event.evidence.module;
  }

  if (typeof event.evidence.filePath === "string" && event.evidence.filePath.length > 0) {
    return deriveModuleName(event.evidence.filePath);
  }

  if (typeof event.evidence.symbolId === "string" && event.evidence.symbolId.length > 0) {
    return deriveModuleName(event.evidence.symbolId.split(":", 1)[0] ?? event.evidence.symbolId);
  }

  return null;
}

async function publishMetrics(nc: NatsConnection, pool: Pool, payload: MetricsWritten): Promise<void> {
  if (payload.metrics.length === 0) {
    return;
  }

  await insertMetrics(pool, payload);
  await publishJson(nc, Subjects.MetricsWritten, payload);
}

function scheduleSimilaritySignatureRefresh(
  pool: Pool,
  qdrant: QdrantClient,
  repoId: string,
): void {
  const current = signatureRefreshes.get(repoId);
  if (current) {
    clearTimeout(current);
  }

  const timeout = setTimeout(() => {
    void writeSimilaritySignatures(pool, qdrant, repoId)
      .then(() => {
        logger.info("similarity signatures refreshed", { repoId });
      })
      .catch((error) => {
        logger.error("similarity signature refresh failed", {
          repoId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        signatureRefreshes.delete(repoId);
      });
  }, 1200);

  signatureRefreshes.set(repoId, timeout);
}

async function loadModuleMetricInputs(pool: Pool, repoId: string, moduleName: string): Promise<ModuleMetricInputs> {
  const latestMetrics = await pool.query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (subject_id, key)
          subject_id,
          key,
          value,
          tags
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'symbol'
          AND tags ->> 'module' = $2
        ORDER BY subject_id, key, at DESC
      )
      SELECT
        COUNT(DISTINCT subject_id) FILTER (WHERE subject_id <> '') AS symbol_count,
        COUNT(DISTINCT tags ->> 'filePath') AS file_count,
        AVG(value) FILTER (WHERE key = 'cyclomatic') AS avg_cyclomatic,
        STDDEV_POP(value) FILTER (WHERE key = 'cyclomatic') AS stddev_cyclomatic,
        MAX(value) FILTER (WHERE key = 'cyclomatic') AS max_cyclomatic,
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

  const churn = await pool.query(
    `
      SELECT COUNT(DISTINCT sha) AS churn_24h
      FROM metrics
      WHERE repo_id = $1
        AND scope = 'symbol'
        AND tags ->> 'module' = $2
        AND at >= NOW() - INTERVAL '24 hours'
    `,
    [repoId, moduleName],
  );

  const alerts = await pool.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE type = 'SEMANTIC_DUPLICATION' AND at >= NOW() - INTERVAL '24 hours') AS duplication_alerts,
        COUNT(*) FILTER (WHERE type = 'ARCH_VIOLATION' AND at >= NOW() - INTERVAL '24 hours') AS arch_violations,
        COUNT(*) FILTER (WHERE type = 'ARCH_EMBED_DRIFT' AND at >= NOW() - INTERVAL '24 hours') AS arch_drift_alerts,
        COUNT(*) FILTER (WHERE type = 'VOLATILITY_ZONE' AND at >= NOW() - INTERVAL '24 hours') AS volatility_alerts
      FROM alerts
      WHERE repo_id = $1
        AND (
          evidence ->> 'module' = $2
          OR evidence ->> 'filePath' LIKE $3
          OR evidence ->> 'symbolId' LIKE $4
        )
    `,
    [repoId, moduleName, modulePathPattern(moduleName), moduleSymbolPattern(moduleName)],
  );

  const summary = latestMetrics.rows[0] ?? {};
  const alertSummary = alerts.rows[0] ?? {};

  return {
    fileCount: toInteger(summary.file_count),
    symbolCount: toInteger(summary.symbol_count),
    avgCyclomatic: toNumber(summary.avg_cyclomatic),
    stddevCyclomatic: toNumber(summary.stddev_cyclomatic),
    maxCyclomatic: toNumber(summary.max_cyclomatic),
    aiEditRatio: Math.max(0, Math.min(1, toNumber(summary.ai_edit_ratio))),
    churn24h: toInteger(churn.rows[0]?.churn_24h),
    duplicationAlerts: toInteger(alertSummary.duplication_alerts),
    archViolations: toInteger(alertSummary.arch_violations),
    archDriftAlerts: toInteger(alertSummary.arch_drift_alerts),
    volatilityAlerts: toInteger(alertSummary.volatility_alerts),
  };
}

async function loadRepoSnapshotInputs(pool: Pool, repoId: string): Promise<RepoSnapshotInputs> {
  const latestMetrics = await pool.query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (subject_id, key)
          subject_id,
          key,
          value,
          tags
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'symbol'
        ORDER BY subject_id, key, at DESC
      )
      SELECT
        COUNT(DISTINCT subject_id) FILTER (WHERE subject_id <> '') AS symbol_count,
        COUNT(DISTINCT tags ->> 'filePath') AS file_count,
        AVG(value) FILTER (WHERE key = 'cyclomatic') AS avg_cyclomatic,
        MAX(value) FILTER (WHERE key = 'cyclomatic') AS max_cyclomatic,
        AVG(value) FILTER (WHERE key = 'ai_risk_score') AS avg_ai_risk,
        AVG(
          CASE
            WHEN COALESCE(tags ->> 'provenance', 'unknown') IN ('human', 'unknown') THEN 0
            ELSE 1
          END
        ) FILTER (WHERE key = 'ai_risk_score') AS ai_edit_ratio
      FROM latest
    `,
    [repoId],
  );

  const churn = await pool.query(
    `
      SELECT COUNT(DISTINCT sha) AS churn_24h
      FROM metrics
      WHERE repo_id = $1
        AND scope = 'symbol'
        AND at >= NOW() - INTERVAL '24 hours'
    `,
    [repoId],
  );

  const alerts = await pool.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE type = 'SEMANTIC_DUPLICATION' AND at >= NOW() - INTERVAL '24 hours') AS duplication_alerts,
        COUNT(*) FILTER (WHERE type = 'ARCH_VIOLATION' AND at >= NOW() - INTERVAL '24 hours') AS arch_violations,
        COUNT(*) FILTER (WHERE type = 'ARCH_PRESSURE' AND at >= NOW() - INTERVAL '24 hours') AS arch_pressure_alerts,
        COUNT(*) FILTER (WHERE type = 'VOLATILITY_ZONE' AND at >= NOW() - INTERVAL '24 hours') AS volatility_alerts
      FROM alerts
      WHERE repo_id = $1
    `,
    [repoId],
  );

  const boundaries = await pool.query(
    `
      SELECT COUNT(*) AS boundary_count
      FROM (
        SELECT DISTINCT ON (subject_id)
          subject_id
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'boundary'
          AND key = 'pressure_index'
        ORDER BY subject_id, at DESC
      ) latest_boundary
    `,
    [repoId],
  );

  const summary = latestMetrics.rows[0] ?? {};
  const alertSummary = alerts.rows[0] ?? {};

  return {
    symbolCount: toInteger(summary.symbol_count),
    fileCount: toInteger(summary.file_count),
    avgCyclomatic: toNumber(summary.avg_cyclomatic),
    maxCyclomatic: toNumber(summary.max_cyclomatic),
    avgAiRisk: toNumber(summary.avg_ai_risk),
    aiEditRatio: Math.max(0, Math.min(1, toNumber(summary.ai_edit_ratio))),
    churn24h: toInteger(churn.rows[0]?.churn_24h),
    duplicationAlerts: toInteger(alertSummary.duplication_alerts),
    archViolations: toInteger(alertSummary.arch_violations),
    archPressureAlerts: toInteger(alertSummary.arch_pressure_alerts),
    volatilityAlerts: toInteger(alertSummary.volatility_alerts),
    boundaryCount: toInteger(boundaries.rows[0]?.boundary_count),
  };
}

async function loadLatestDependencySnapshot(pool: Pool, repoId: string, moduleName: string): Promise<{
  dependencyEntropy: number;
  moduleDependencyCount: number;
  externalDependencyCount: number;
}> {
  const result = await pool.query(
    `
      SELECT
        value,
        tags
      FROM metrics
      WHERE repo_id = $1
        AND scope = 'module'
        AND subject_id = $2
        AND key = 'dependency_entropy'
      ORDER BY at DESC
      LIMIT 1
    `,
    [repoId, moduleName],
  );

  const row = result.rows[0];
  const tags = row?.tags && typeof row.tags === "object" ? row.tags as Record<string, unknown> : {};

  return {
    dependencyEntropy: toNumber(row?.value) / 100,
    moduleDependencyCount: toInteger(tags.moduleDependencyCount),
    externalDependencyCount: toInteger(tags.externalDependencyCount),
  };
}

async function loadPreviousPressureState(
  pool: Pool,
  repoId: string,
  moduleName: string,
  beforeAt: string,
): Promise<PreviousPressureState> {
  const result = await pool.query(
    `
      SELECT key, value, tags
      FROM (
        SELECT DISTINCT ON (key)
          key,
          value,
          tags,
          at
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'module'
          AND subject_id = $2
          AND key = ANY($3::text[])
          AND at < $4
        ORDER BY key, at DESC
      ) latest
    `,
    [repoId, moduleName, ["dependency_entropy", "code_entropy_index", "pressure_index"], beforeAt],
  );

  let previousModuleDependencyCount = 0;
  let previousModuleEntropyIndex = 0;
  let previousModulePressureIndex = 0;

  for (const row of result.rows) {
    if (row.key === "dependency_entropy") {
      const tags = row.tags && typeof row.tags === "object" ? row.tags as Record<string, unknown> : {};
      previousModuleDependencyCount = toInteger(tags.moduleDependencyCount);
    }

    if (row.key === "code_entropy_index") {
      previousModuleEntropyIndex = toNumber(row.value);
    }

    if (row.key === "pressure_index") {
      previousModulePressureIndex = toNumber(row.value);
    }
  }

  return {
    previousModuleDependencyCount,
    previousModuleEntropyIndex,
    previousModulePressureIndex,
  };
}

function buildModuleEntropyMetrics(input: {
  moduleName: string;
  dependencyEntropy: number;
  moduleDependencyCount: number;
  externalDependencyCount: number;
  moduleInputs: ModuleMetricInputs;
}): MetricsWritten["metrics"] {
  const externalDependencyRatio = input.externalDependencyCount / Math.max(input.moduleDependencyCount, 1);
  const duplicationEntropy = computeDuplicationEntropy(input.moduleInputs.duplicationAlerts, input.moduleInputs.symbolCount);
  const complexityEntropy = computeComplexityEntropy({
    avgCyclomatic: input.moduleInputs.avgCyclomatic,
    stddevCyclomatic: input.moduleInputs.stddevCyclomatic,
    maxCyclomatic: input.moduleInputs.maxCyclomatic,
  });
  const changeEntropy = computeChangeEntropy({
    churn24h: input.moduleInputs.churn24h,
    fileCount: input.moduleInputs.fileCount,
    aiEditRatio: input.moduleInputs.aiEditRatio,
    volatilityAlerts: input.moduleInputs.volatilityAlerts,
  });
  const architectureEntropy = computeArchitectureEntropy({
    externalDependencyRatio,
    violationCount: input.moduleInputs.archViolations,
    moduleDependencyCount: input.moduleDependencyCount,
    driftAlerts: input.moduleInputs.archDriftAlerts,
  });
  const entropyIndex = computeCodeEntropyIndex({
    dependencyEntropy: input.dependencyEntropy,
    duplicationEntropy,
    complexityEntropy,
    changeEntropy,
    architectureEntropy,
  });

  const tags = {
    module: input.moduleName,
    moduleDependencyCount: String(input.moduleDependencyCount),
    externalDependencyCount: String(input.externalDependencyCount),
    symbolCount: String(input.moduleInputs.symbolCount),
    fileCount: String(input.moduleInputs.fileCount),
  };

  return [
    buildMetric("module", "dependency_entropy", input.dependencyEntropy * 100, input.moduleName, tags),
    buildMetric("module", "duplication_entropy", duplicationEntropy * 100, input.moduleName, tags),
    buildMetric("module", "complexity_entropy", complexityEntropy * 100, input.moduleName, tags),
    buildMetric("module", "change_entropy", changeEntropy * 100, input.moduleName, tags),
    buildMetric("module", "architecture_entropy", architectureEntropy * 100, input.moduleName, tags),
    buildMetric("module", "code_entropy_index", entropyIndex, input.moduleName, tags),
  ];
}

function buildModulePressureMetrics(input: {
  moduleName: string;
  moduleInputs: ModuleMetricInputs;
  moduleDependencyCount: number;
  externalDependencyCount: number;
  moduleEntropyIndex: number;
  repoEntropyIndex: number;
  previousState: PreviousPressureState;
  addedEdgeCount: number;
}): MetricsWritten["metrics"] {
  const components = computeArchitecturePressureComponents({
    churn24h: input.moduleInputs.churn24h,
    fileCount: input.moduleInputs.fileCount,
    aiEditRatio: input.moduleInputs.aiEditRatio,
    moduleDependencyCount: input.moduleDependencyCount,
    previousModuleDependencyCount: input.previousState.previousModuleDependencyCount,
    externalDependencyCount: input.externalDependencyCount,
    duplicationAlerts: input.moduleInputs.duplicationAlerts,
    symbolCount: input.moduleInputs.symbolCount,
    archViolations: input.moduleInputs.archViolations,
    addedEdgeCount: input.addedEdgeCount,
    moduleEntropyIndex: input.moduleEntropyIndex,
    repoEntropyIndex: input.repoEntropyIndex,
    previousModuleEntropyIndex: input.previousState.previousModuleEntropyIndex,
    volatilityAlerts: input.moduleInputs.volatilityAlerts,
  });
  const pressureIndex = computeArchitecturePressureIndex(components);

  const tags = {
    module: input.moduleName,
    moduleDependencyCount: String(input.moduleDependencyCount),
    externalDependencyCount: String(input.externalDependencyCount),
    churn24h: String(input.moduleInputs.churn24h),
    aiEditRatio: input.moduleInputs.aiEditRatio.toFixed(4),
    addedEdgeCount: String(input.addedEdgeCount),
    previousPressureIndex: input.previousState.previousModulePressureIndex.toFixed(2),
    repoEntropyIndex: input.repoEntropyIndex.toFixed(2),
  };

  return [
    buildMetric("module", "pressure_change", components.change * 100, input.moduleName, tags),
    buildMetric("module", "pressure_coupling", components.coupling * 100, input.moduleName, tags),
    buildMetric("module", "pressure_semantic", components.semantic * 100, input.moduleName, tags),
    buildMetric("module", "pressure_boundary", components.boundary * 100, input.moduleName, tags),
    buildMetric("module", "pressure_entropy", components.entropy * 100, input.moduleName, tags),
    buildMetric("module", "pressure_volatility", components.volatility * 100, input.moduleName, tags),
    buildMetric("module", "pressure_index", pressureIndex, input.moduleName, tags),
  ];
}

function buildBoundaryPressureMetrics(input: {
  moduleName: string;
  currentEdges: string[];
  addedEdges: string[];
  pressureIndex: number;
  moduleDependencyCount: number;
  archViolations: number;
  repoEntropyIndex: number;
}): MetricsWritten["metrics"] {
  if (input.currentEdges.length === 0) {
    return [];
  }

  return input.currentEdges.map((edge) => {
    const [, target = "unknown"] = edge.split("->", 2);
    const pressureIndex = computeBoundaryPressureIndex({
      modulePressureIndex: input.pressureIndex,
      edgeAdded: input.addedEdges.includes(edge),
      externalTarget: target.startsWith("pkg:"),
      archViolations: input.archViolations,
      moduleDependencyCount: input.moduleDependencyCount,
      repoEntropyIndex: input.repoEntropyIndex,
    });

    return buildMetric("boundary", "pressure_index", pressureIndex, edge, {
      module: input.moduleName,
      sourceModule: input.moduleName,
      targetModule: target,
      edgeAdded: input.addedEdges.includes(edge) ? "1" : "0",
      externalTarget: target.startsWith("pkg:") ? "1" : "0",
    });
  });
}

function shouldThrottleEntropyRefresh(repoId: string, moduleName: string, commitSha: string): boolean {
  const key = `${repoId}:${moduleName}:${commitSha}`;
  const now = Date.now();
  const previous = entropyRefreshes.get(key);
  entropyRefreshes.set(key, now);

  for (const [entry, ts] of entropyRefreshes.entries()) {
    if (now - ts > 30_000) {
      entropyRefreshes.delete(entry);
    }
  }

  return previous !== undefined && (now - previous) < 2_000;
}

function shouldWriteArchitectureSnapshot(
  repoId: string,
  scope: "repo" | "module",
  subjectId: string,
  force: boolean,
): boolean {
  const key = `${repoId}:${scope}:${subjectId}`;
  const now = Date.now();
  const previous = architectureSnapshotRefreshes.get(key);

  if (force || previous === undefined || (now - previous) >= 10 * 60_000) {
    architectureSnapshotRefreshes.set(key, now);
    for (const [entry, ts] of architectureSnapshotRefreshes.entries()) {
      if (now - ts > 24 * 60 * 60_000) {
        architectureSnapshotRefreshes.delete(entry);
      }
    }
    return true;
  }

  return false;
}

function metricValue(metrics: MetricsWritten["metrics"], scope: "repo" | "module", subjectId: string, key: string): number {
  return toNumber(
    metrics.find((metric) =>
      metric.scope === scope
      && (metric.subjectId ?? "") === subjectId
      && metric.key === key)?.value,
  );
}

async function insertArchitectureSnapshot(input: {
  pool: Pool;
  repoId: string;
  commitSha: string;
  at: string;
  scope: "repo" | "module";
  subjectId: string;
  signature: Record<string, unknown>;
}): Promise<void> {
  await input.pool.query(
    `
      INSERT INTO architecture_snapshots (repo_id, sha, at, scope, subject_id, signature)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (repo_id, sha, scope, subject_id)
      DO UPDATE SET at = EXCLUDED.at, signature = EXCLUDED.signature
    `,
    [
      input.repoId,
      input.commitSha,
      input.at,
      input.scope,
      input.subjectId,
      JSON.stringify(input.signature),
    ],
  );
}

async function loadRepoEntropyAverages(pool: Pool, repoId: string): Promise<RepoEntropyAverages> {
  const result = await pool.query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (subject_id, key)
          subject_id,
          key,
          value
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'module'
          AND key = ANY($2::text[])
        ORDER BY subject_id, key, at DESC
      )
      SELECT
        AVG(value) FILTER (WHERE key = 'dependency_entropy') AS dependency_entropy,
        AVG(value) FILTER (WHERE key = 'duplication_entropy') AS duplication_entropy,
        AVG(value) FILTER (WHERE key = 'complexity_entropy') AS complexity_entropy,
        AVG(value) FILTER (WHERE key = 'change_entropy') AS change_entropy,
        AVG(value) FILTER (WHERE key = 'architecture_entropy') AS architecture_entropy,
        AVG(value) FILTER (WHERE key = 'code_entropy_index') AS code_entropy_index,
        COUNT(DISTINCT subject_id) AS module_count
      FROM latest
    `,
    [
      repoId,
      [
      "dependency_entropy",
      "duplication_entropy",
      "complexity_entropy",
      "change_entropy",
      "architecture_entropy",
      "code_entropy_index",
      ],
    ],
  );

  const row = result.rows[0] ?? {};
  return {
    dependencyEntropy: toNumber(row.dependency_entropy),
    duplicationEntropy: toNumber(row.duplication_entropy),
    complexityEntropy: toNumber(row.complexity_entropy),
    changeEntropy: toNumber(row.change_entropy),
    architectureEntropy: toNumber(row.architecture_entropy),
    codeEntropyIndex: toNumber(row.code_entropy_index),
    moduleCount: toInteger(row.module_count),
  };
}

function buildRepoEntropyMetrics(repoId: string, repoAverages: RepoEntropyAverages): MetricsWritten["metrics"] {
  const tags = {
    moduleCount: String(toInteger(repoAverages.moduleCount)),
  };

  return [
    buildMetric("repo", "dependency_entropy", repoAverages.dependencyEntropy, repoId, tags),
    buildMetric("repo", "duplication_entropy", repoAverages.duplicationEntropy, repoId, tags),
    buildMetric("repo", "complexity_entropy", repoAverages.complexityEntropy, repoId, tags),
    buildMetric("repo", "change_entropy", repoAverages.changeEntropy, repoId, tags),
    buildMetric("repo", "architecture_entropy", repoAverages.architectureEntropy, repoId, tags),
    buildMetric("repo", "code_entropy_index", repoAverages.codeEntropyIndex, repoId, tags),
  ];
}

async function loadRepoPressureAverages(pool: Pool, repoId: string): Promise<RepoPressureAverages> {
  const result = await pool.query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (subject_id, key)
          subject_id,
          key,
          value
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'module'
          AND key = ANY($2::text[])
        ORDER BY subject_id, key, at DESC
      )
      SELECT
        AVG(value) FILTER (WHERE key = 'pressure_change') AS pressure_change,
        AVG(value) FILTER (WHERE key = 'pressure_coupling') AS pressure_coupling,
        AVG(value) FILTER (WHERE key = 'pressure_semantic') AS pressure_semantic,
        AVG(value) FILTER (WHERE key = 'pressure_boundary') AS pressure_boundary,
        AVG(value) FILTER (WHERE key = 'pressure_entropy') AS pressure_entropy,
        AVG(value) FILTER (WHERE key = 'pressure_volatility') AS pressure_volatility,
        AVG(value) FILTER (WHERE key = 'pressure_index') AS pressure_index,
        COUNT(DISTINCT subject_id) AS module_count
      FROM latest
    `,
    [
      repoId,
      [
        "pressure_change",
        "pressure_coupling",
        "pressure_semantic",
        "pressure_boundary",
        "pressure_entropy",
        "pressure_volatility",
        "pressure_index",
      ],
    ],
  );

  const row = result.rows[0] ?? {};
  return {
    changePressure: toNumber(row.pressure_change),
    couplingPressure: toNumber(row.pressure_coupling),
    semanticPressure: toNumber(row.pressure_semantic),
    boundaryPressure: toNumber(row.pressure_boundary),
    entropyPressure: toNumber(row.pressure_entropy),
    volatilityPressure: toNumber(row.pressure_volatility),
    pressureIndex: toNumber(row.pressure_index),
    moduleCount: toInteger(row.module_count),
  };
}

function buildRepoPressureMetrics(repoId: string, repoAverages: RepoPressureAverages): MetricsWritten["metrics"] {
  const tags = {
    moduleCount: String(toInteger(repoAverages.moduleCount)),
  };

  return [
    buildMetric("repo", "pressure_change", repoAverages.changePressure, repoId, tags),
    buildMetric("repo", "pressure_coupling", repoAverages.couplingPressure, repoId, tags),
    buildMetric("repo", "pressure_semantic", repoAverages.semanticPressure, repoId, tags),
    buildMetric("repo", "pressure_boundary", repoAverages.boundaryPressure, repoId, tags),
    buildMetric("repo", "pressure_entropy", repoAverages.entropyPressure, repoId, tags),
    buildMetric("repo", "pressure_volatility", repoAverages.volatilityPressure, repoId, tags),
    buildMetric("repo", "pressure_index", repoAverages.pressureIndex, repoId, tags),
  ];
}

async function writeEntropySnapshot(input: {
  nc: NatsConnection;
  pool: Pool;
  repoId: string;
  commitSha: string;
  moduleName: string;
  dependencyEntropy: number;
  moduleDependencyCount: number;
  externalDependencyCount: number;
  currentEdges?: string[];
  addedEdges?: string[];
  removedEdges?: string[];
}): Promise<void> {
  const moduleInputs = await loadModuleMetricInputs(input.pool, input.repoId, input.moduleName);
  const moduleMetrics = buildModuleEntropyMetrics({
    moduleName: input.moduleName,
    dependencyEntropy: input.dependencyEntropy,
    moduleDependencyCount: input.moduleDependencyCount,
    externalDependencyCount: input.externalDependencyCount,
    moduleInputs,
  });

  const at = new Date().toISOString();

  await publishMetrics(input.nc, input.pool, {
    schemaVersion: 1,
    repoId: input.repoId,
    commitSha: input.commitSha,
    at,
    metrics: moduleMetrics,
  });

  const repoAverages = await loadRepoEntropyAverages(input.pool, input.repoId);
  const repoMetrics = buildRepoEntropyMetrics(input.repoId, repoAverages);

  await publishMetrics(input.nc, input.pool, {
    schemaVersion: 1,
    repoId: input.repoId,
    commitSha: input.commitSha,
    at: new Date().toISOString(),
    metrics: repoMetrics,
  });

  const previousPressureState = await loadPreviousPressureState(input.pool, input.repoId, input.moduleName, at);
  const moduleEntropyIndex = moduleMetrics.find((metric) => metric.key === "code_entropy_index")?.value ?? 0;
  const repoEntropyIndex = repoMetrics.find((metric) => metric.key === "code_entropy_index")?.value ?? 0;
  const modulePressureMetrics = buildModulePressureMetrics({
    moduleName: input.moduleName,
    moduleInputs,
    moduleDependencyCount: input.moduleDependencyCount,
    externalDependencyCount: input.externalDependencyCount,
    moduleEntropyIndex,
    repoEntropyIndex,
    previousState: previousPressureState,
    addedEdgeCount: input.addedEdges?.length ?? 0,
  });

  await publishMetrics(input.nc, input.pool, {
    schemaVersion: 1,
    repoId: input.repoId,
    commitSha: input.commitSha,
    at: new Date().toISOString(),
    metrics: modulePressureMetrics,
  });

  const repoPressureAverages = await loadRepoPressureAverages(input.pool, input.repoId);
  const repoPressureMetrics = buildRepoPressureMetrics(input.repoId, repoPressureAverages);

  await publishMetrics(input.nc, input.pool, {
    schemaVersion: 1,
    repoId: input.repoId,
    commitSha: input.commitSha,
    at: new Date().toISOString(),
    metrics: repoPressureMetrics,
  });

  const modulePressureIndex = modulePressureMetrics.find((metric) => metric.key === "pressure_index")?.value ?? 0;
  const boundaryMetrics = buildBoundaryPressureMetrics({
    moduleName: input.moduleName,
    currentEdges: input.currentEdges ?? [],
    addedEdges: input.addedEdges ?? [],
    pressureIndex: modulePressureIndex,
    moduleDependencyCount: input.moduleDependencyCount,
    archViolations: moduleInputs.archViolations,
    repoEntropyIndex,
  });

  await publishMetrics(input.nc, input.pool, {
    schemaVersion: 1,
    repoId: input.repoId,
    commitSha: input.commitSha,
    at: new Date().toISOString(),
    metrics: boundaryMetrics,
  });

  const repoInputs = await loadRepoSnapshotInputs(input.pool, input.repoId);
  const repoPressureIndex = repoPressureMetrics.find((metric) => metric.key === "pressure_index")?.value ?? 0;
  const moduleForceSnapshot = (
    moduleEntropyIndex >= 70
    || modulePressureIndex >= 60
    || moduleInputs.archViolations > 0
    || moduleInputs.archDriftAlerts > 0
    || (input.addedEdges?.length ?? 0) > 0
    || (input.removedEdges?.length ?? 0) > 0
  );
  const repoForceSnapshot = (
    repoEntropyIndex >= 65
    || repoPressureIndex >= 55
    || repoInputs.archViolations > 0
    || repoInputs.archPressureAlerts > 0
  );

  if (shouldWriteArchitectureSnapshot(input.repoId, "module", input.moduleName, moduleForceSnapshot)) {
    await insertArchitectureSnapshot({
      pool: input.pool,
      repoId: input.repoId,
      commitSha: input.commitSha,
      at,
      scope: "module",
      subjectId: input.moduleName,
      signature: {
        graph: {
          moduleDependencyCount: input.moduleDependencyCount,
          externalDependencyCount: input.externalDependencyCount,
          currentEdgeCount: input.currentEdges?.length ?? input.moduleDependencyCount,
          addedEdgeCount: input.addedEdges?.length ?? 0,
          removedEdgeCount: input.removedEdges?.length ?? 0,
          archViolations: moduleInputs.archViolations,
          archDriftAlerts: moduleInputs.archDriftAlerts,
          edgesAdded: (input.addedEdges ?? []).slice(0, 8),
          edgesRemoved: (input.removedEdges ?? []).slice(0, 8),
        },
        semantic: {
          symbolCount: moduleInputs.symbolCount,
          fileCount: moduleInputs.fileCount,
          aiEditRatio: Number(moduleInputs.aiEditRatio.toFixed(4)),
          duplicationAlerts: moduleInputs.duplicationAlerts,
        },
        health: {
          entropyIndex: Number(moduleEntropyIndex.toFixed(2)),
          pressureIndex: Number(modulePressureIndex.toFixed(2)),
          dependencyEntropy: Number(metricValue(moduleMetrics, "module", input.moduleName, "dependency_entropy").toFixed(2)),
          duplicationEntropy: Number(metricValue(moduleMetrics, "module", input.moduleName, "duplication_entropy").toFixed(2)),
          complexityEntropy: Number(metricValue(moduleMetrics, "module", input.moduleName, "complexity_entropy").toFixed(2)),
          changeEntropy: Number(metricValue(moduleMetrics, "module", input.moduleName, "change_entropy").toFixed(2)),
          architectureEntropy: Number(metricValue(moduleMetrics, "module", input.moduleName, "architecture_entropy").toFixed(2)),
          pressureChange: Number(metricValue(modulePressureMetrics, "module", input.moduleName, "pressure_change").toFixed(2)),
          pressureCoupling: Number(metricValue(modulePressureMetrics, "module", input.moduleName, "pressure_coupling").toFixed(2)),
          pressureSemantic: Number(metricValue(modulePressureMetrics, "module", input.moduleName, "pressure_semantic").toFixed(2)),
          pressureBoundary: Number(metricValue(modulePressureMetrics, "module", input.moduleName, "pressure_boundary").toFixed(2)),
          pressureEntropy: Number(metricValue(modulePressureMetrics, "module", input.moduleName, "pressure_entropy").toFixed(2)),
          pressureVolatility: Number(metricValue(modulePressureMetrics, "module", input.moduleName, "pressure_volatility").toFixed(2)),
        },
        complexity: {
          avgCyclomatic: Number(moduleInputs.avgCyclomatic.toFixed(2)),
          stddevCyclomatic: Number(moduleInputs.stddevCyclomatic.toFixed(2)),
          maxCyclomatic: Number(moduleInputs.maxCyclomatic.toFixed(2)),
        },
        volatility: {
          churn24h: moduleInputs.churn24h,
          volatilityAlerts: moduleInputs.volatilityAlerts,
        },
      },
    });
  }

  if (shouldWriteArchitectureSnapshot(input.repoId, "repo", input.repoId, repoForceSnapshot)) {
    await insertArchitectureSnapshot({
      pool: input.pool,
      repoId: input.repoId,
      commitSha: input.commitSha,
      at,
      scope: "repo",
      subjectId: input.repoId,
      signature: {
        graph: {
          moduleCount: repoAverages.moduleCount,
          boundaryCount: repoInputs.boundaryCount,
          archViolations: repoInputs.archViolations,
          activeModule: input.moduleName,
        },
        semantic: {
          symbolCount: repoInputs.symbolCount,
          fileCount: repoInputs.fileCount,
          avgAiRisk: Number(repoInputs.avgAiRisk.toFixed(2)),
          aiEditRatio: Number(repoInputs.aiEditRatio.toFixed(4)),
          duplicationAlerts: repoInputs.duplicationAlerts,
        },
        health: {
          entropyIndex: Number(repoEntropyIndex.toFixed(2)),
          pressureIndex: Number(repoPressureIndex.toFixed(2)),
          dependencyEntropy: Number(metricValue(repoMetrics, "repo", input.repoId, "dependency_entropy").toFixed(2)),
          duplicationEntropy: Number(metricValue(repoMetrics, "repo", input.repoId, "duplication_entropy").toFixed(2)),
          complexityEntropy: Number(metricValue(repoMetrics, "repo", input.repoId, "complexity_entropy").toFixed(2)),
          changeEntropy: Number(metricValue(repoMetrics, "repo", input.repoId, "change_entropy").toFixed(2)),
          architectureEntropy: Number(metricValue(repoMetrics, "repo", input.repoId, "architecture_entropy").toFixed(2)),
          pressureChange: Number(metricValue(repoPressureMetrics, "repo", input.repoId, "pressure_change").toFixed(2)),
          pressureCoupling: Number(metricValue(repoPressureMetrics, "repo", input.repoId, "pressure_coupling").toFixed(2)),
          pressureSemantic: Number(metricValue(repoPressureMetrics, "repo", input.repoId, "pressure_semantic").toFixed(2)),
          pressureBoundary: Number(metricValue(repoPressureMetrics, "repo", input.repoId, "pressure_boundary").toFixed(2)),
          pressureEntropy: Number(metricValue(repoPressureMetrics, "repo", input.repoId, "pressure_entropy").toFixed(2)),
          pressureVolatility: Number(metricValue(repoPressureMetrics, "repo", input.repoId, "pressure_volatility").toFixed(2)),
        },
        complexity: {
          avgCyclomatic: Number(repoInputs.avgCyclomatic.toFixed(2)),
          maxCyclomatic: Number(repoInputs.maxCyclomatic.toFixed(2)),
        },
        volatility: {
          churn24h: repoInputs.churn24h,
          volatilityAlerts: repoInputs.volatilityAlerts,
          archPressureAlerts: repoInputs.archPressureAlerts,
        },
      },
    });
  }

  logger.info("entropy snapshot written", {
    repoId: input.repoId,
    moduleName: input.moduleName,
    codeEntropyIndex: moduleMetrics.find((metric) => metric.key === "code_entropy_index")?.value ?? 0,
    pressureIndex: modulePressureMetrics.find((metric) => metric.key === "pressure_index")?.value ?? 0,
  });
}

export function startMetricsWorker(nc: NatsConnection, pool: Pool, qdrant: QdrantClient): void {
  subscribeJson<SymbolsExtracted>(nc, Subjects.SymbolsExtracted, async (event) => {
    const metrics: MetricsWritten["metrics"] = [];

    for (const symbol of event.symbols) {
      const bodyText = symbol.bodyText ?? "";
      const cyclomatic = estimateCyclomaticComplexity(bodyText);
      const nesting = estimateNestingDepth(bodyText);
      const lines = countLines(bodyText);
      const smells = findAiSmells(bodyText, symbol.name);
      const aiRisk = computeAiRiskScore({
        cyclomatic,
        nesting,
        dummyData: smells.dummyData,
        hardcodedSecrets: smells.hardcodedSecrets,
        overAbstractedName: smells.overAbstractedName,
        todoMarkers: smells.todoMarkers,
      });

      const sharedTags = {
        filePath: event.filePath,
        module: symbol.modulePath ?? "root",
        provenance: symbol.provenance ?? "unknown",
      };

      metrics.push(buildMetric("symbol", "cyclomatic", cyclomatic, symbol.symbolId, sharedTags));
      metrics.push(buildMetric("symbol", "nesting_depth", nesting, symbol.symbolId, sharedTags));
      metrics.push(buildMetric("symbol", "line_count", lines, symbol.symbolId, sharedTags));
      metrics.push(buildMetric("symbol", "ai_risk_score", aiRisk, symbol.symbolId, sharedTags));
      metrics.push(buildMetric("symbol", "dummy_data", smells.dummyData, symbol.symbolId, sharedTags));
      metrics.push(buildMetric("symbol", "hardcoded_secrets", smells.hardcodedSecrets, symbol.symbolId, sharedTags));
      metrics.push(buildMetric("symbol", "over_abstracted_name", smells.overAbstractedName, symbol.symbolId, sharedTags));
      metrics.push(buildMetric("symbol", "todo_markers", smells.todoMarkers, symbol.symbolId, sharedTags));
    }

    await publishMetrics(nc, pool, {
      schemaVersion: 1,
      repoId: event.repoId,
      commitSha: event.commitSha,
      at: new Date().toISOString(),
      metrics,
    });

    logger.info("symbol metrics written", {
      repoId: event.repoId,
      filePath: event.filePath,
      count: metrics.length,
    });
    scheduleSimilaritySignatureRefresh(pool, qdrant, event.repoId);
  });

  subscribeJson<GraphUpdated>(nc, Subjects.GraphUpdated, async (event) => {
    const moduleName = event.moduleName ?? deriveModuleName(event.filePath);
    const dependencyEntropy = computeDependencyEntropy(event.graphEdgesCurrent ?? []);

    await writeEntropySnapshot({
      nc,
      pool,
      repoId: event.repoId,
      commitSha: event.commitSha,
      moduleName,
      dependencyEntropy,
      moduleDependencyCount: toInteger(event.moduleDependencyCount),
      externalDependencyCount: toInteger(event.externalDependencyCount),
      currentEdges: event.graphEdgesCurrent,
      addedEdges: event.graphEdgesAdded,
      removedEdges: event.graphEdgesRemoved,
    });
    scheduleSimilaritySignatureRefresh(pool, qdrant, event.repoId);
  });

  subscribeJson<AlertRaised>(nc, Subjects.AlertRaised, async (event) => {
    if (!["SEMANTIC_DUPLICATION", "ARCH_VIOLATION", "ARCH_EMBED_DRIFT", "VOLATILITY_ZONE"].includes(event.type)) {
      return;
    }

    const moduleName = resolveAlertModule(event);
    if (!moduleName) {
      return;
    }

    if (shouldThrottleEntropyRefresh(event.repoId, moduleName, event.commitSha)) {
      return;
    }

    const dependencySnapshot = await loadLatestDependencySnapshot(pool, event.repoId, moduleName);

    await writeEntropySnapshot({
      nc,
      pool,
      repoId: event.repoId,
      commitSha: event.commitSha,
      moduleName,
      dependencyEntropy: dependencySnapshot.dependencyEntropy,
      moduleDependencyCount: dependencySnapshot.moduleDependencyCount,
      externalDependencyCount: dependencySnapshot.externalDependencyCount,
    });
    scheduleSimilaritySignatureRefresh(pool, qdrant, event.repoId);
  });
}
