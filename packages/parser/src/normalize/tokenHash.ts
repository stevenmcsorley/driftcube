import { createHash } from "node:crypto";

export function hashTokens(source: string): string {
  const tokens = source
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter(Boolean)
    .sort()
    .join("|");

  return createHash("sha256").update(tokens).digest("hex");
}

