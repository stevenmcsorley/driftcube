export function collectImportSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(/(?:from\s+["']([^"']+)["'])|(?:import\s+["']([^"']+)["'])/g))
    .map((match) => match[1] ?? match[2])
    .filter((value): value is string => Boolean(value));
}

export function collectCallCandidates(source: string): string[] {
  const matches = Array.from(source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g));
  const reserved = new Set(["if", "for", "while", "switch", "catch", "return", "typeof"]);

  return matches
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .filter((value) => !reserved.has(value))
    .slice(0, 32);
}
