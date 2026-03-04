import { createHash } from "node:crypto";

function normalizeCode(source: string): string {
  return source
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "\"str\"")
    .replace(/\b\d+\b/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashCode(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function hashNormalizedCode(source: string): string {
  return hashCode(normalizeCode(source));
}

