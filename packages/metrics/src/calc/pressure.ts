function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function normalize(value: number, baseline: number): number {
  if (baseline <= 0) {
    return clamp01(value);
  }

  return clamp01(value / baseline);
}

export interface ArchitecturePressureComponents {
  change: number;
  coupling: number;
  semantic: number;
  boundary: number;
  entropy: number;
  volatility: number;
}

export function computeArchitecturePressureComponents(input: {
  churn24h: number;
  fileCount: number;
  aiEditRatio: number;
  moduleDependencyCount: number;
  previousModuleDependencyCount: number;
  externalDependencyCount: number;
  duplicationAlerts: number;
  symbolCount: number;
  archViolations: number;
  addedEdgeCount: number;
  moduleEntropyIndex: number;
  repoEntropyIndex: number;
  previousModuleEntropyIndex: number;
  volatilityAlerts: number;
}): ArchitecturePressureComponents {
  const normalizedChangeRate = clamp01(
    normalize(input.churn24h, Math.max(1, input.fileCount * 4)) * (1 + input.aiEditRatio * 0.65),
  );

  const couplingDelta = Math.max(0, input.moduleDependencyCount - input.previousModuleDependencyCount);
  const couplingPressure = clamp01(
    normalize(couplingDelta, Math.max(1, input.previousModuleDependencyCount || 2))
    + normalize(input.externalDependencyCount, Math.max(1, input.moduleDependencyCount * 0.75)) * 0.35,
  );

  const semanticPressure = clamp01(
    normalize(input.duplicationAlerts, Math.max(1, input.symbolCount * 0.45))
    + (input.aiEditRatio * 0.2),
  );

  const boundaryPressure = clamp01(
    normalize(input.addedEdgeCount, Math.max(1, input.moduleDependencyCount * 0.35))
    + normalize(input.archViolations, Math.max(1, input.moduleDependencyCount * 0.4)) * 0.75,
  );

  const repoGap = Math.max(0, input.moduleEntropyIndex - input.repoEntropyIndex);
  const localEntropyDelta = Math.max(0, input.moduleEntropyIndex - input.previousModuleEntropyIndex);
  const entropyPressure = clamp01(
    normalize(repoGap, 20) + normalize(localEntropyDelta, 15) * 0.8,
  );

  const volatilityPressure = clamp01(
    normalize(input.volatilityAlerts, 2)
    + normalize(input.churn24h, Math.max(1, input.fileCount * 7)) * 0.5,
  );

  return {
    change: normalizedChangeRate,
    coupling: couplingPressure,
    semantic: semanticPressure,
    boundary: boundaryPressure,
    entropy: entropyPressure,
    volatility: volatilityPressure,
  };
}

export function computeArchitecturePressureIndex(components: ArchitecturePressureComponents): number {
  const weighted = (
    (components.change * 0.25)
    + (components.coupling * 0.2)
    + (components.semantic * 0.15)
    + (components.boundary * 0.15)
    + (components.entropy * 0.15)
    + (components.volatility * 0.1)
  ) * 100;

  return Number(weighted.toFixed(2));
}

export function computeBoundaryPressureIndex(input: {
  modulePressureIndex: number;
  edgeAdded: boolean;
  externalTarget: boolean;
  archViolations: number;
  moduleDependencyCount: number;
  repoEntropyIndex: number;
}): number {
  const violationPressure = normalize(input.archViolations, Math.max(1, input.moduleDependencyCount * 0.45));
  const externalPressure = input.externalTarget ? 1 : 0.2;
  const edgeAdditionPressure = input.edgeAdded ? 1 : 0.2;
  const entropyPressure = normalize(input.repoEntropyIndex, 85);
  const modulePressure = normalize(input.modulePressureIndex, 100);

  return Number((
    (
      (edgeAdditionPressure * 0.35)
      + (externalPressure * 0.2)
      + (violationPressure * 0.25)
      + (modulePressure * 0.15)
      + (entropyPressure * 0.05)
    ) * 100
  ).toFixed(2));
}
