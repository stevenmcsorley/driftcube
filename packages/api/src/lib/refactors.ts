import { createHash } from "node:crypto";
import { deriveModuleName, type RefactorSuggestion } from "@driftcube/shared";
import type { Pool } from "pg";

interface AlertRow {
  sha: string;
  at: string | Date;
  type: string;
  severity: string;
  title: string;
  evidence: Record<string, unknown>;
}

interface ComponentRow {
  id: string;
  name: string;
  avg_cyclomatic: unknown;
  avg_ai_risk: unknown;
  entropy_index: unknown;
  pressure_index: unknown;
}

interface MetricRow {
  key: string;
  value: unknown;
  tags: Record<string, unknown> | null;
}

interface SimulationState {
  entropyIndex: number;
  pressureIndex: number;
  duplicationIndex: number;
  couplingIndex: number;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function moduleFromEvidence(evidence: Record<string, unknown>): string {
  if (typeof evidence.module === "string" && evidence.module.length > 0) {
    return evidence.module;
  }

  if (typeof evidence.filePath === "string" && evidence.filePath.length > 0) {
    return deriveModuleName(evidence.filePath);
  }

  if (typeof evidence.symbolId === "string" && evidence.symbolId.length > 0) {
    return deriveModuleName(evidence.symbolId.split(":", 1)[0] ?? evidence.symbolId);
  }

  return "root";
}

function filePathFromEvidence(evidence: Record<string, unknown>): string {
  return typeof evidence.filePath === "string" ? evidence.filePath : "unknown";
}

function symbolFromEvidence(evidence: Record<string, unknown>): string | null {
  return typeof evidence.symbolId === "string" ? evidence.symbolId : null;
}

function edgeListFromEvidence(evidence: Record<string, unknown>): string[] {
  return Array.isArray(evidence.graphEdgesAdded) ? evidence.graphEdgesAdded.map((edge) => String(edge)) : [];
}

function averageNeighbourScore(evidenceRows: Record<string, unknown>[]): number {
  const scores = evidenceRows.flatMap((evidence) => (
    Array.isArray(evidence.neighbours)
      ? evidence.neighbours
        .map((item) => {
          if (typeof item !== "object" || item === null) {
            return 0;
          }

          return toNumber((item as Record<string, unknown>).score);
        })
      : []
  )).filter((score) => score > 0);

  if (scores.length === 0) {
    return 0;
  }

  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function pressureDrivers(metrics: MetricRow[]): string[] {
  const interesting = metrics
    .map((metric) => ({
      key: metric.key,
      value: toNumber(metric.value),
    }))
    .filter((metric) => metric.key.startsWith("pressure_") && metric.key !== "pressure_index")
    .sort((left, right) => right.value - left.value)
    .slice(0, 3);

  return interesting.map((metric) => {
    const label = metric.key.replace("pressure_", "").replaceAll("_", " ");
    return `${label} pressure ${round(metric.value)}`;
  });
}

function hashId(repoId: string, type: string, target: string): string {
  return createHash("sha1")
    .update(`${repoId}:${type}:${target}`)
    .digest("hex")
    .slice(0, 14);
}

function buildSuggestion(
  repoId: string,
  scope: RefactorSuggestion["scope"],
  target: string,
  type: RefactorSuggestion["type"],
  confidence: number,
  impact: RefactorSuggestion["impact"],
  evidence: RefactorSuggestion["evidence"],
  plan: string[],
): RefactorSuggestion {
  return {
    id: `rfx_${hashId(repoId, type, target)}`,
    repoId,
    at: new Date().toISOString(),
    scope,
    target,
    type,
    confidence: round(confidence),
    impact,
    simulation: undefined,
    evidence,
    plan,
    status: "proposed",
  };
}

async function loadComponentRows(pool: Pool, repoId: string): Promise<ComponentRow[]> {
  const result = await pool.query<ComponentRow>(
    `
      WITH latest_symbol AS (
        SELECT DISTINCT ON (subject_id, key)
          subject_id,
          key,
          value,
          tags
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'symbol'
        ORDER BY subject_id, key, at DESC
      ),
      latest_module AS (
        SELECT DISTINCT ON (subject_id, key)
          subject_id,
          key,
          value
        FROM metrics
        WHERE repo_id = $1
          AND scope = 'module'
        ORDER BY subject_id, key, at DESC
      )
      SELECT
        COALESCE(s.tags ->> 'module', 'root') AS id,
        COALESCE(s.tags ->> 'module', 'root') AS name,
        ROUND(AVG(CASE WHEN s.key = 'cyclomatic' THEN s.value END)::numeric, 2) AS avg_cyclomatic,
        ROUND(AVG(CASE WHEN s.key = 'ai_risk_score' THEN s.value END)::numeric, 2) AS avg_ai_risk,
        ROUND(MAX(CASE WHEN m.key = 'code_entropy_index' THEN m.value END)::numeric, 2) AS entropy_index,
        ROUND(MAX(CASE WHEN m.key = 'pressure_index' THEN m.value END)::numeric, 2) AS pressure_index
      FROM latest_symbol s
      LEFT JOIN latest_module m
        ON m.subject_id = COALESCE(s.tags ->> 'module', 'root')
      GROUP BY 1, 2
      ORDER BY 2 ASC
    `,
    [repoId],
  );

  return result.rows;
}

async function loadRecentAlerts(pool: Pool, repoId: string): Promise<AlertRow[]> {
  const result = await pool.query<AlertRow>(
    `
      SELECT sha, at, type, severity, title, evidence
      FROM alerts
      WHERE repo_id = $1
      ORDER BY at DESC
      LIMIT 200
    `,
    [repoId],
  );

  return result.rows;
}

async function loadModulePressureMetrics(pool: Pool, repoId: string, moduleName: string): Promise<MetricRow[]> {
  const result = await pool.query<MetricRow>(
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
        ORDER BY key, at DESC
      ) latest
    `,
    [
      repoId,
      moduleName,
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

  return result.rows;
}

async function loadSimulationState(pool: Pool, repoId: string, moduleName: string): Promise<SimulationState> {
  const result = await pool.query<MetricRow>(
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
        ORDER BY key, at DESC
      ) latest
    `,
    [
      repoId,
      moduleName,
      [
        "code_entropy_index",
        "pressure_index",
        "duplication_entropy",
        "dependency_entropy",
        "pressure_coupling",
        "pressure_boundary",
      ],
    ],
  );

  const values = Object.fromEntries(result.rows.map((row) => [row.key, toNumber(row.value)])) as Record<string, number>;
  const couplingIndex = Math.max(
    values.dependency_entropy ?? 0,
    ((values.pressure_coupling ?? 0) + (values.pressure_boundary ?? 0)) / 2,
  );

  return {
    entropyIndex: round(values.code_entropy_index ?? 0),
    pressureIndex: round(values.pressure_index ?? 0),
    duplicationIndex: round(values.duplication_entropy ?? 0),
    couplingIndex: round(couplingIndex),
  };
}

function clampIndex(value: number): number {
  return round(Math.max(0, Math.min(100, value)));
}

function buildSimulation(
  method: string,
  confidence: number,
  before: SimulationState,
  after: SimulationState,
  assumptions: string[],
): NonNullable<RefactorSuggestion["simulation"]> {
  return {
    method,
    confidence: round(confidence),
    before: {
      entropyIndex: clampIndex(before.entropyIndex),
      pressureIndex: clampIndex(before.pressureIndex),
      duplicationIndex: clampIndex(before.duplicationIndex),
      couplingIndex: clampIndex(before.couplingIndex),
    },
    after: {
      entropyIndex: clampIndex(after.entropyIndex),
      pressureIndex: clampIndex(after.pressureIndex),
      duplicationIndex: clampIndex(after.duplicationIndex),
      couplingIndex: clampIndex(after.couplingIndex),
    },
    assumptions,
  };
}

function impactFromSimulation(before: SimulationState, after: SimulationState): RefactorSuggestion["impact"] {
  return {
    entropyDelta: round(after.entropyIndex - before.entropyIndex),
    pressureDelta: round(after.pressureIndex - before.pressureIndex),
    duplicationDelta: round(after.duplicationIndex - before.duplicationIndex),
    couplingDelta: round(after.couplingIndex - before.couplingIndex),
  };
}

async function generateDedupeSuggestions(
  pool: Pool,
  repoId: string,
  alerts: AlertRow[],
  components: Map<string, ComponentRow>,
): Promise<RefactorSuggestion[]> {
  const groups = new Map<string, AlertRow[]>();

  for (const alert of alerts.filter((row) => row.type === "SEMANTIC_DUPLICATION")) {
    const filePath = filePathFromEvidence(alert.evidence);
    const current = groups.get(filePath) ?? [];
    current.push(alert);
    groups.set(filePath, current);
  }

  const suggestions = await Promise.all(Array.from(groups.entries())
    .filter(([, rows]) => rows.length >= 2)
    .map(async ([filePath, rows]) => {
      const moduleName = moduleFromEvidence(rows[0]?.evidence ?? {});
      const component = components.get(moduleName);
      const symbols = Array.from(new Set(
        rows.map((row) => symbolFromEvidence(row.evidence)).filter((value): value is string => Boolean(value)),
      )).slice(0, 6);
      const avgScore = averageNeighbourScore(rows.map((row) => row.evidence));
      const confidence = Math.min(0.95, 0.6 + (rows.length * 0.08) + (avgScore * 0.18));
      const before = await loadSimulationState(pool, repoId, moduleName);
      const after = {
        entropyIndex: before.entropyIndex - Math.min(Math.max(before.entropyIndex * 0.16, 6), rows.length * 4.5 + (avgScore * 8)),
        pressureIndex: before.pressureIndex - Math.min(Math.max(before.pressureIndex * 0.14, 4), rows.length * 3 + (avgScore * 5)),
        duplicationIndex: before.duplicationIndex - Math.min(Math.max(before.duplicationIndex * 0.35, 10), rows.length * 9 + (avgScore * 10)),
        couplingIndex: before.couplingIndex - Math.min(Math.max(before.couplingIndex * 0.08, 2), rows.length * 2.5),
      };
      const simulation = buildSimulation(
        "metric_projection_v2",
        confidence,
        before,
        after,
        [
          `dedupe cluster size ${rows.length}`,
          `average semantic similarity ${(avgScore * 100).toFixed(1)}%`,
          "shared helper extraction removes paraphrased duplicate flows before recalculating pressure",
        ],
      );
      const suggestion = buildSuggestion(
        repoId,
        "file",
        filePath,
        "DEDUPE_CLUSTER",
        confidence,
        impactFromSimulation(simulation.before, simulation.after),
        {
          topDrivers: [
            `semantic duplication cluster size=${rows.length}`,
            `average similarity ${(avgScore * 100).toFixed(1)}%`,
            `module pressure ${round(toNumber(component?.pressure_index))}`,
          ],
          entities: {
            files: [filePath],
            modules: [moduleName],
            symbols,
            alertShas: rows.slice(0, 4).map((row) => row.sha),
          },
        },
        [
          `Choose a canonical implementation for the duplicate logic in ${filePath}.`,
          `Extract the shared behavior behind ${symbols.slice(0, 3).join(", ") || "the duplicate symbols"}.`,
          "Replace callers with the shared helper and remove paraphrased implementations.",
          "Add regression tests around the preserved behavior before deleting the duplicates.",
        ],
      );
      suggestion.simulation = simulation;

      return suggestion;
    }));

  return suggestions;
}

async function generateBoundarySuggestions(pool: Pool, repoId: string, alerts: AlertRow[]): Promise<RefactorSuggestion[]> {
  const groups = new Map<string, AlertRow[]>();

  for (const alert of alerts.filter((row) => row.type === "ARCH_VIOLATION")) {
    const edges = edgeListFromEvidence(alert.evidence);
    for (const edge of edges) {
      const current = groups.get(edge) ?? [];
      current.push(alert);
      groups.set(edge, current);
    }
  }

  const suggestions = await Promise.all(Array.from(groups.entries())
    .filter(([, rows]) => rows.length >= 1)
    .map(async ([edge, rows]) => {
      const [source = "unknown", target = "unknown"] = edge.split(" -> ");
      const moduleName = moduleFromEvidence(rows[0]?.evidence ?? {});
      const confidence = Math.min(0.96, 0.72 + (rows.length * 0.07));
      const before = await loadSimulationState(pool, repoId, moduleName);
      const after = {
        entropyIndex: before.entropyIndex - Math.min(Math.max(before.entropyIndex * 0.18, 8), rows.length * 6 + 6),
        pressureIndex: before.pressureIndex - Math.min(Math.max(before.pressureIndex * 0.22, 8), rows.length * 7 + 8),
        duplicationIndex: before.duplicationIndex,
        couplingIndex: before.couplingIndex - Math.min(Math.max(before.couplingIndex * 0.24, 10), rows.length * 9 + 8),
      };
      const simulation = buildSimulation(
        "boundary_inversion_projection_v1",
        confidence,
        before,
        after,
        [
          `forbidden edge ${source} -> ${target}`,
          `${rows.length} violating observation(s) in the recent alert window`,
          "adapter inversion removes one invalid boundary lane and cools coupling pressure",
        ],
      );
      const suggestion = buildSuggestion(
        repoId,
        "boundary",
        edge,
        "INVERT_BOUNDARY",
        confidence,
        impactFromSimulation(simulation.before, simulation.after),
        {
          topDrivers: [
            `forbidden boundary observed ${rows.length} time(s)`,
            `edge ${source} -> ${target}`,
            `module ${moduleName} is leaning across an invalid layer boundary`,
          ],
          entities: {
            modules: [moduleName],
            files: Array.from(new Set(rows.map((row) => filePathFromEvidence(row.evidence)))).slice(0, 3),
            edgesAdded: [edge],
            alertShas: rows.slice(0, 4).map((row) => row.sha),
          },
        },
        [
          `Introduce an adapter boundary so ${moduleName} depends on an internal interface instead of ${target}.`,
          `Move the concrete ${target} implementation behind infra or web, depending on ownership.`,
          "Replace direct imports with the adapter and lock the boundary with a regression test.",
          "Keep the interface stable so later AI edits cannot reopen the forbidden dependency.",
        ],
      );
      suggestion.simulation = simulation;

      return suggestion;
    }));

  return suggestions
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 6);
}

async function generateExtractModuleSuggestions(
  pool: Pool,
  repoId: string,
  alerts: AlertRow[],
  components: ComponentRow[],
): Promise<RefactorSuggestion[]> {
  const suggestions: RefactorSuggestion[] = [];

  for (const component of components) {
    const moduleName = component.id;
    const pressure = toNumber(component.pressure_index);
    const entropy = toNumber(component.entropy_index);
    if (pressure < 50 && entropy < 70) {
      continue;
    }

    const moduleAlerts = alerts.filter((alert) => moduleFromEvidence(alert.evidence) === moduleName);
    const duplicationAlerts = moduleAlerts.filter((alert) => alert.type === "SEMANTIC_DUPLICATION");
    const boundaryAlerts = moduleAlerts.filter((alert) => alert.type === "ARCH_VIOLATION");
    const driftAlerts = moduleAlerts.filter((alert) => alert.type === "ARCH_EMBED_DRIFT" || alert.type === "ARCH_PRESSURE");
    if (duplicationAlerts.length === 0 && boundaryAlerts.length === 0 && driftAlerts.length === 0) {
      continue;
    }

    const pressureMetrics = await loadModulePressureMetrics(pool, repoId, moduleName);
    const drivers = [
      ...pressureDrivers(pressureMetrics),
      duplicationAlerts.length > 0 ? `${duplicationAlerts.length} semantic duplication signal(s)` : null,
      boundaryAlerts.length > 0 ? `${boundaryAlerts.length} boundary violation signal(s)` : null,
    ].filter((value): value is string => Boolean(value)).slice(0, 4);

    const symbols = Array.from(new Set(
      duplicationAlerts.map((alert) => symbolFromEvidence(alert.evidence)).filter((value): value is string => Boolean(value)),
    )).slice(0, 6);
    const edges = Array.from(new Set(
      boundaryAlerts.flatMap((alert) => edgeListFromEvidence(alert.evidence)),
    )).slice(0, 4);

    const confidence = Math.min(
      0.93,
      0.58 + (pressure / 250) + (entropy / 400) + (duplicationAlerts.length * 0.03) + (boundaryAlerts.length * 0.04),
    );

    const before = await loadSimulationState(pool, repoId, moduleName);
    const after = {
      entropyIndex: before.entropyIndex - Math.min(Math.max(before.entropyIndex * 0.24, 10), duplicationAlerts.length * 5 + boundaryAlerts.length * 4 + 10),
      pressureIndex: before.pressureIndex - Math.min(Math.max(before.pressureIndex * 0.28, 12), duplicationAlerts.length * 4 + boundaryAlerts.length * 5 + 12),
      duplicationIndex: before.duplicationIndex - Math.min(Math.max(before.duplicationIndex * 0.22, 8), duplicationAlerts.length * 8 + 8),
      couplingIndex: before.couplingIndex - Math.min(Math.max(before.couplingIndex * 0.2, 8), boundaryAlerts.length * 9 + 6),
    };
    const simulation = buildSimulation(
      "module_extraction_projection_v1",
      confidence,
      before,
      after,
      [
        `pressure drivers ${drivers.join(", ") || "module pressure spike"}`,
        `${duplicationAlerts.length} duplication and ${boundaryAlerts.length} boundary signals feed the extraction hypothesis`,
        "projected state assumes the extracted slice becomes its own module and removes cross-layer imports",
      ],
    );
    const suggestion = buildSuggestion(
      repoId,
      "module",
      moduleName,
      "EXTRACT_MODULE",
      confidence,
      impactFromSimulation(simulation.before, simulation.after),
      {
        topDrivers: drivers.length > 0 ? drivers : [
          `module pressure ${round(pressure)}`,
          `module entropy ${round(entropy)}`,
        ],
        entities: {
          modules: [moduleName],
          symbols,
          edgesAdded: edges,
          alertShas: moduleAlerts.slice(0, 5).map((alert) => alert.sha),
        },
      },
      [
        `Carve a focused submodule out of ${moduleName} around the dominant duplicate and high-pressure logic.`,
        `Move ${symbols.slice(0, 3).join(", ") || "the most entangled symbols"} behind that extracted boundary.`,
        "Update callers so the original module becomes an orchestration surface instead of a mixed-responsibility hotspot.",
        "Remove forbidden imports and add module-level tests before more churn lands in the same area.",
      ],
    );
    suggestion.simulation = simulation;
    suggestions.push(suggestion);
  }

  return suggestions;
}

export async function generateRefactorSuggestions(pool: Pool, repoId: string): Promise<RefactorSuggestion[]> {
  const [components, alerts] = await Promise.all([
    loadComponentRows(pool, repoId),
    loadRecentAlerts(pool, repoId),
  ]);
  const componentIndex = new Map(components.map((component) => [component.id, component]));

  const suggestions = [
    ...(await generateDedupeSuggestions(pool, repoId, alerts, componentIndex)),
    ...(await generateBoundarySuggestions(pool, repoId, alerts)),
    ...(await generateExtractModuleSuggestions(pool, repoId, alerts, components)),
  ]
    .sort((left, right) => {
      const leftImpact = Math.abs(left.impact.pressureDelta ?? 0) + Math.abs(left.impact.entropyDelta ?? 0);
      const rightImpact = Math.abs(right.impact.pressureDelta ?? 0) + Math.abs(right.impact.entropyDelta ?? 0);
      return (right.confidence + rightImpact) - (left.confidence + leftImpact);
    })
    .slice(0, 12);

  return suggestions;
}

export async function replaceRefactorSuggestions(pool: Pool, repoId: string, suggestions: RefactorSuggestion[]): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const ids = suggestions.map((suggestion) => suggestion.id);

    if (ids.length === 0) {
      await client.query("DELETE FROM refactor_suggestions WHERE repo_id = $1", [repoId]);
    } else {
      await client.query(
        "DELETE FROM refactor_suggestions WHERE repo_id = $1 AND NOT (id = ANY($2::text[]))",
        [repoId, ids],
      );
    }

    for (const suggestion of suggestions) {
      await client.query(
        `
          INSERT INTO refactor_suggestions (
            repo_id, id, at, scope, target, type, confidence, impact, simulation, evidence, plan, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12)
          ON CONFLICT (repo_id, id)
          DO UPDATE SET
            at = EXCLUDED.at,
            scope = EXCLUDED.scope,
            target = EXCLUDED.target,
            type = EXCLUDED.type,
            confidence = EXCLUDED.confidence,
            impact = EXCLUDED.impact,
            simulation = EXCLUDED.simulation,
            evidence = EXCLUDED.evidence,
            plan = EXCLUDED.plan,
            status = CASE
              WHEN refactor_suggestions.status IN ('accepted', 'applied', 'dismissed') THEN refactor_suggestions.status
              ELSE EXCLUDED.status
            END
        `,
        [
          suggestion.repoId,
          suggestion.id,
          suggestion.at,
          suggestion.scope,
          suggestion.target,
          suggestion.type,
          suggestion.confidence,
          JSON.stringify(suggestion.impact),
          JSON.stringify(suggestion.simulation ?? {}),
          JSON.stringify(suggestion.evidence),
          JSON.stringify(suggestion.plan),
          suggestion.status ?? "proposed",
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
