import type { Pool } from "pg";
import type { MetricPoint } from "@driftcube/shared";

interface BaselineStats {
  mean: number;
  stddev: number;
  sampleCount: number;
}

export interface EntropyAnomalyAssessment {
  previousValue: number;
  delta: number;
  baselineMean: number;
  baselineStddev: number;
  sampleCount: number;
  zScore: number;
  warnThreshold: number;
  errorThreshold: number;
  clearThreshold: number;
  severity: "warn" | "error" | null;
}

export interface PressureAnomalyAssessment {
  previousValue: number;
  baseline24h: number;
  delta24h: number;
  baselineMean: number;
  baselineStddev: number;
  sampleCount: number;
  zScore: number;
  warnThreshold: number;
  errorThreshold: number;
  clearThreshold: number;
  severity: "warn" | "error" | null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadPreviousValue(
  pool: Pool,
  input: {
    repoId: string;
    scope: MetricPoint["scope"];
    subjectId: string;
    key: string;
    at: string;
  },
): Promise<number> {
  const result = await pool.query<{ value: number }>(
    `
      SELECT value
      FROM metrics
      WHERE repo_id = $1
        AND scope = $2
        AND key = $3
        AND COALESCE(subject_id, '') = $4
        AND at < $5
      ORDER BY at DESC
      LIMIT 1
    `,
    [input.repoId, input.scope, input.key, input.subjectId, input.at],
  );

  return toNumber(result.rows[0]?.value);
}

async function loadRollingBaseline(
  pool: Pool,
  input: {
    repoId: string;
    scope: MetricPoint["scope"];
    subjectId: string;
    key: string;
    at: string;
  },
): Promise<BaselineStats> {
  const result = await pool.query<{
    mean_value: number;
    stddev_value: number;
    sample_count: number;
  }>(
    `
      SELECT
        COALESCE(AVG(value), 0) AS mean_value,
        COALESCE(STDDEV_POP(value), 0) AS stddev_value,
        COUNT(*) AS sample_count
      FROM metrics
      WHERE repo_id = $1
        AND scope = $2
        AND key = $3
        AND COALESCE(subject_id, '') = $4
        AND at < $5
        AND at >= $5::timestamptz - INTERVAL '7 days'
    `,
    [input.repoId, input.scope, input.key, input.subjectId, input.at],
  );

  return {
    mean: toNumber(result.rows[0]?.mean_value),
    stddev: toNumber(result.rows[0]?.stddev_value),
    sampleCount: Math.max(0, Math.round(toNumber(result.rows[0]?.sample_count))),
  };
}

function computeZScore(currentValue: number, mean: number, stddev: number): number {
  if (stddev > 0.001) {
    return (currentValue - mean) / stddev;
  }

  return currentValue > mean ? 4 : 0;
}

export async function assessEntropyAnomaly(
  pool: Pool,
  input: {
    repoId: string;
    scope: "repo" | "module";
    subjectId: string;
    at: string;
    currentValue: number;
  },
): Promise<EntropyAnomalyAssessment> {
  const previousValue = await loadPreviousValue(pool, {
    repoId: input.repoId,
    scope: input.scope,
    subjectId: input.subjectId,
    key: "code_entropy_index",
    at: input.at,
  });
  const baseline = await loadRollingBaseline(pool, {
    repoId: input.repoId,
    scope: input.scope,
    subjectId: input.subjectId,
    key: "code_entropy_index",
    at: input.at,
  });

  const delta = Number((input.currentValue - previousValue).toFixed(2));
  const zScore = Number(computeZScore(input.currentValue, baseline.mean, baseline.stddev).toFixed(2));

  let warnThreshold = 60;
  let errorThreshold = 80;

  if (baseline.sampleCount >= 4) {
    warnThreshold = Math.max(45, baseline.mean + Math.max(baseline.stddev * 2, 6));
    errorThreshold = Math.max(65, baseline.mean + Math.max(baseline.stddev * 3, 10));
  }

  const warnLow = warnThreshold - 8;
  const errorLow = errorThreshold - 10;
  const crossedWarn = previousValue < warnLow && input.currentValue >= warnThreshold;
  const crossedError = previousValue < errorLow && input.currentValue >= errorThreshold;
  const acceleratedWarn = input.currentValue >= warnThreshold && delta >= Math.max(6, baseline.stddev);
  const acceleratedError = input.currentValue >= errorThreshold && delta >= Math.max(10, baseline.stddev * 1.5);
  const severeAnomaly = input.currentValue >= errorThreshold && zScore >= 3.25;
  const warnAnomaly = input.currentValue >= warnThreshold && zScore >= 2.25;

  let severity: "warn" | "error" | null = null;
  if (crossedError || acceleratedError || severeAnomaly) {
    severity = "error";
  } else if (crossedWarn || acceleratedWarn || warnAnomaly) {
    severity = "warn";
  }

  return {
    previousValue,
    delta,
    baselineMean: Number(baseline.mean.toFixed(2)),
    baselineStddev: Number(baseline.stddev.toFixed(2)),
    sampleCount: baseline.sampleCount,
    zScore,
    warnThreshold: Number(warnThreshold.toFixed(2)),
    errorThreshold: Number(errorThreshold.toFixed(2)),
    clearThreshold: Number(Math.max(35, baseline.mean + Math.max(baseline.stddev * 1.15, 3)).toFixed(2)),
    severity,
  };
}

async function loadPressure24hBaseline(
  pool: Pool,
  input: {
    repoId: string;
    subjectId: string;
    at: string;
  },
): Promise<number> {
  const result = await pool.query<{ value: number }>(
    `
      SELECT value
      FROM metrics
      WHERE repo_id = $1
        AND scope = 'module'
        AND key = 'pressure_index'
        AND subject_id = $2
        AND at <= $3::timestamptz - INTERVAL '24 hours'
      ORDER BY at DESC
      LIMIT 1
    `,
    [input.repoId, input.subjectId, input.at],
  );

  return toNumber(result.rows[0]?.value);
}

export async function assessPressureAnomaly(
  pool: Pool,
  input: {
    repoId: string;
    subjectId: string;
    at: string;
    currentValue: number;
  },
): Promise<PressureAnomalyAssessment> {
  const previousValue = await loadPreviousValue(pool, {
    repoId: input.repoId,
    scope: "module",
    subjectId: input.subjectId,
    key: "pressure_index",
    at: input.at,
  });
  const baseline = await loadRollingBaseline(pool, {
    repoId: input.repoId,
    scope: "module",
    subjectId: input.subjectId,
    key: "pressure_index",
    at: input.at,
  });
  const baseline24h = await loadPressure24hBaseline(pool, {
    repoId: input.repoId,
    subjectId: input.subjectId,
    at: input.at,
  });

  const zScore = Number(computeZScore(input.currentValue, baseline.mean, baseline.stddev).toFixed(2));
  const delta24h = Number((input.currentValue - (baseline24h || previousValue)).toFixed(2));

  let warnThreshold = 75;
  let errorThreshold = 85;
  if (baseline.sampleCount >= 4) {
    warnThreshold = Math.max(45, baseline.mean + Math.max(baseline.stddev * 2, 7));
    errorThreshold = Math.max(60, baseline.mean + Math.max(baseline.stddev * 3, 12));
  }

  const warnLow = warnThreshold - 7;
  const errorLow = errorThreshold - 10;
  const crossedWarn = previousValue < warnLow && input.currentValue >= warnThreshold;
  const crossedError = previousValue < errorLow && input.currentValue >= errorThreshold;
  const warnAnomaly = input.currentValue >= warnThreshold && (zScore >= 2.1 || delta24h >= 6);
  const errorAnomaly = input.currentValue >= errorThreshold && (zScore >= 3.1 || delta24h >= 12);

  let severity: "warn" | "error" | null = null;
  if (crossedError || errorAnomaly) {
    severity = "error";
  } else if (crossedWarn || warnAnomaly) {
    severity = "warn";
  }

  return {
    previousValue,
    baseline24h: Number((baseline24h || previousValue).toFixed(2)),
    delta24h,
    baselineMean: Number(baseline.mean.toFixed(2)),
    baselineStddev: Number(baseline.stddev.toFixed(2)),
    sampleCount: baseline.sampleCount,
    zScore,
    warnThreshold: Number(warnThreshold.toFixed(2)),
    errorThreshold: Number(errorThreshold.toFixed(2)),
    clearThreshold: Number(Math.max(30, baseline.mean + Math.max(baseline.stddev * 1.15, 4)).toFixed(2)),
    severity,
  };
}
