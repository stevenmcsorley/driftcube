import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Subjects, publishJson, subscribeJson, type FilesChanged, type SymbolsExtracted } from "@driftcube/shared";
import type { NatsConnection } from "nats";
import { createLogger } from "@driftcube/shared";
import { extractPythonSymbols } from "./extract/symbols_py.js";
import { extractTypeScriptSymbols } from "./extract/symbols_ts.js";
import { scanContentHeuristics } from "./scan/contentHeuristics.js";
import { detectLanguageFromPath } from "./treesitter/index.js";

const logger = createLogger("parser");

function shouldParse(language: string | undefined): language is string {
  return language === "typescript" || language === "javascript" || language === "python";
}

function mergeTelemetryProvenance(
  symbols: SymbolsExtracted["symbols"],
  fallback: FilesChanged["changes"][number]["provenance"],
): SymbolsExtracted["symbols"] {
  if (!fallback || fallback === "unknown") {
    return symbols;
  }

  return symbols.map((symbol) => ({
    ...symbol,
    provenance: !symbol.provenance || symbol.provenance === "unknown" ? fallback : symbol.provenance,
  }));
}

async function parseChange(event: FilesChanged, change: FilesChanged["changes"][number], nc: NatsConnection): Promise<void> {
  if (change.changeType === "deleted") {
    return;
  }

  const language = change.language ?? detectLanguageFromPath(change.path);
  const absolutePath = change.absolutePath ?? resolve(event.rootPath ?? ".", change.path);
  const source = await readFile(absolutePath, "utf8");

  if (!shouldParse(language)) {
    logger.info("change skipped by parser", {
      repoId: event.repoId,
      filePath: change.path,
      language: language ?? "unknown",
      reason: "unsupported-language",
    });

    const alerts = scanContentHeuristics({
      repoId: event.repoId,
      commitSha: event.commitSha,
      at: new Date().toISOString(),
      filePath: change.path,
      language: language ?? "unknown",
      source,
    });

    for (const alert of alerts) {
      await publishJson(nc, Subjects.AlertRaised, alert);
      logger.warn("content heuristic alert raised", {
        repoId: alert.repoId,
        filePath: change.path,
        severity: alert.severity,
      });
    }
    return;
  }

  const symbols = language === "python"
    ? extractPythonSymbols(change.path, source)
    : extractTypeScriptSymbols(change.path, source);

  const payload: SymbolsExtracted = {
    schemaVersion: 1,
    repoId: event.repoId,
    commitSha: event.commitSha,
    rootPath: event.rootPath,
    filePath: change.path,
    absolutePath,
    language,
    symbols: mergeTelemetryProvenance(symbols, change.provenance),
  };

  logger.info("symbols extracted", {
    repoId: payload.repoId,
    filePath: payload.filePath,
    symbolCount: symbols.length,
  });
  await publishJson(nc, Subjects.SymbolsExtracted, payload);
}

export function startParserWorker(nc: NatsConnection): void {
  subscribeJson<FilesChanged>(nc, Subjects.FilesChanged, async (event) => {
    for (const change of event.changes) {
      await parseChange(event, change, nc);
    }
  });
}
