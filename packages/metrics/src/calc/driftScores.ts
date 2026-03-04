export function computeAiRiskScore(input: {
  cyclomatic: number;
  nesting: number;
  dummyData: number;
  hardcodedSecrets: number;
  overAbstractedName: number;
  todoMarkers: number;
}): number {
  return Math.min(
    100,
    (input.cyclomatic * 2)
      + (input.nesting * 4)
      + (input.dummyData * 20)
      + (input.hardcodedSecrets * 25)
      + (input.overAbstractedName * 10)
      + (input.todoMarkers * 8),
  );
}

