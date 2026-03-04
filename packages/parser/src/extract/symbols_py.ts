import { deriveModuleName, type ExtractedSymbol } from "@driftcube/shared";
import { collectImportSpecifiers, collectCallCandidates } from "./imports.js";
import { hashCode, hashNormalizedCode } from "../normalize/astHash.js";
import { hashTokens } from "../normalize/tokenHash.js";

function getBlock(lines: string[], startIndex: number): string {
  const header = lines[startIndex] ?? "";
  const indent = header.match(/^\s*/)?.[0].length ?? 0;
  const collected = [header];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextIndent = line.match(/^\s*/)?.[0].length ?? 0;

    if (line.trim() && nextIndent <= indent && !line.startsWith(" ".repeat(indent + 1))) {
      break;
    }

    collected.push(line);
  }

  return collected.join("\n");
}

export function extractPythonSymbols(filePath: string, source: string): ExtractedSymbol[] {
  const lines = source.split(/\r?\n/);
  const imports = collectImportSpecifiers(source);
  const symbols: ExtractedSymbol[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const functionMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/);

    if (!functionMatch && !classMatch) {
      continue;
    }

    const kind = functionMatch ? "function" : "class";
    const name = functionMatch?.[1] ?? classMatch?.[1] ?? "anonymous";
    const bodyText = getBlock(lines, index);

    symbols.push({
      symbolId: `${filePath}:${name}:${index + 1}`,
      kind,
      name,
      signature: name,
      startLine: index + 1,
      endLine: index + bodyText.split(/\r?\n/).length,
      hash: hashCode(bodyText),
      normHash: hashNormalizedCode(bodyText),
      tokensHash: hashTokens(bodyText),
      modulePath: deriveModuleName(filePath),
      provenance: inferProvenance(bodyText),
      textRef: `inline://${filePath}#${name}`,
      bodyText,
      imports,
      calls: collectCallCandidates(bodyText),
    });
  }

  return symbols;
}

function inferProvenance(bodyText: string): ExtractedSymbol["provenance"] {
  const lower = bodyText.toLowerCase();
  if (lower.includes("generated-by: claude")) return "claude";
  if (lower.includes("generated-by: codex")) return "codex";
  if (lower.includes("generated-by: cursor")) return "cursor";
  return "unknown";
}
