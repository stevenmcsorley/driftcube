export function churnWeight(provenance: string | undefined): number {
  if (provenance === "claude" || provenance === "codex" || provenance === "cursor") {
    return 2;
  }

  return 1;
}

