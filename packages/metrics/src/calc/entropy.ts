function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function shannonEntropy(values: number[]): number {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  if (positive.length <= 1) {
    return 0;
  }

  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return 0;
  }

  const raw = positive.reduce((sum, value) => {
    const probability = value / total;
    return sum - (probability * Math.log2(probability));
  }, 0);

  return clamp01(raw / Math.log2(positive.length));
}

export function computeDependencyEntropy(edges: string[]): number {
  const buckets = new Map<string, number>();

  for (const edge of edges) {
    const target = edge.split("->", 2)[1] ?? edge;
    buckets.set(target, (buckets.get(target) ?? 0) + 1);
  }

  return shannonEntropy(Array.from(buckets.values()));
}

export function computeDuplicationEntropy(duplicationAlerts: number, symbolCount: number): number {
  return clamp01((duplicationAlerts * 2) / Math.max(symbolCount, 1));
}

export function computeComplexityEntropy(input: {
  avgCyclomatic: number;
  stddevCyclomatic: number;
  maxCyclomatic: number;
}): number {
  const spread = input.stddevCyclomatic / Math.max(input.avgCyclomatic, 4);
  const spikes = input.maxCyclomatic / Math.max(input.avgCyclomatic * 3, 1);
  return clamp01((spread * 0.7) + (Math.min(spikes, 3) / 3 * 0.3));
}

export function computeChangeEntropy(input: {
  churn24h: number;
  fileCount: number;
  aiEditRatio: number;
  volatilityAlerts: number;
}): number {
  const churnPressure = input.churn24h / Math.max(input.fileCount * 4, 1);
  const volatilityPressure = Math.min(input.volatilityAlerts / 4, 1);

  return clamp01((churnPressure * 0.55) + (input.aiEditRatio * 0.3) + (volatilityPressure * 0.15));
}

export function computeArchitectureEntropy(input: {
  externalDependencyRatio: number;
  violationCount: number;
  moduleDependencyCount: number;
  driftAlerts: number;
}): number {
  const rulePressure = Math.min((input.violationCount + input.driftAlerts) / Math.max(input.moduleDependencyCount, 1), 1);
  return clamp01((input.externalDependencyRatio * 0.35) + (rulePressure * 0.65));
}

export function computeCodeEntropyIndex(input: {
  dependencyEntropy: number;
  duplicationEntropy: number;
  complexityEntropy: number;
  changeEntropy: number;
  architectureEntropy: number;
}): number {
  const weighted = (
    (input.dependencyEntropy * 0.25)
    + (input.duplicationEntropy * 0.2)
    + (input.complexityEntropy * 0.2)
    + (input.changeEntropy * 0.2)
    + (input.architectureEntropy * 0.15)
  ) * 100;

  return Number(weighted.toFixed(2));
}

