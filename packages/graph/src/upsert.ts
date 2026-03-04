import { collapsePackageName, deriveModuleName, resolveImportPath, type SymbolsExtracted } from "@driftcube/shared";
import type neo4j from "neo4j-driver";

export interface GraphUpsertSummary {
  moduleName: string;
  currentEdges: string[];
  addedEdges: string[];
  removedEdges: string[];
  externalDependencyCount: number;
}

function importTarget(sourceFilePath: string, path: string): { kind: "File" | "Package"; id: string } {
  const resolved = resolveImportPath(sourceFilePath, path);
  if (resolved) {
    return { kind: "File", id: resolved };
  }

  return { kind: "Package", id: collapsePackageName(path) };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

export async function upsertGraph(driver: neo4j.Driver, event: SymbolsExtracted): Promise<GraphUpsertSummary> {
  const session = driver.session();
  const moduleName = deriveModuleName(event.filePath);
  const nextDependencyEdges = new Set<string>();
  let externalDependencyCount = 0;

  for (const symbol of event.symbols) {
    for (const entry of symbol.imports ?? []) {
      const target = importTarget(event.filePath, entry);
      if (target.kind === "Package") {
        nextDependencyEdges.add(`${moduleName}->pkg:${target.id}`);
        externalDependencyCount += 1;
        continue;
      }

      const targetModule = deriveModuleName(target.id);
      nextDependencyEdges.add(`${moduleName}->${targetModule}`);
    }
  }

  const nextEdges = Array.from(nextDependencyEdges).sort();
  let previousEdges: string[] = [];

  try {
    const previous = await session.run(
      `
        MATCH (f:File {repoId: $repoId, path: $filePath})
        RETURN f.dependencyEdges AS dependencyEdges
      `,
      {
        repoId: event.repoId,
        filePath: event.filePath,
      },
    );
    previousEdges = toStringArray(previous.records[0]?.get("dependencyEdges"));

    await session.executeWrite(async (tx) => {
      await tx.run(
        `
          MERGE (r:Repo {repoId: $repoId})
          MERGE (c:Commit {repoId: $repoId, sha: $commitSha})
          SET c.timestamp = datetime($timestamp)
          MERGE (f:File {repoId: $repoId, path: $filePath})
          SET f.language = $language
          MERGE (m:Module {repoId: $repoId, name: $moduleName})
          MERGE (r)-[:HAS_COMMIT]->(c)
          MERGE (m)-[:CONTAINS]->(f)
        `,
        {
          repoId: event.repoId,
          commitSha: event.commitSha,
          timestamp: new Date().toISOString(),
          filePath: event.filePath,
          language: event.language,
          moduleName,
        },
      );

      await tx.run(
        `
          MATCH (f:File {repoId: $repoId, path: $filePath})-[r:IMPORTS]->()
          DELETE r
        `,
        {
          repoId: event.repoId,
          filePath: event.filePath,
        },
      );

      for (const symbol of event.symbols) {
        await tx.run(
          `
            MATCH (f:File {repoId: $repoId, path: $filePath})
            MATCH (m:Module {repoId: $repoId, name: $moduleName})
            MERGE (s:Symbol {repoId: $repoId, symbolId: $symbolId})
            SET s.kind = $kind,
                s.name = $name,
                s.signature = $signature,
                s.startLine = $startLine,
                s.endLine = $endLine,
                s.hash = $hash,
                s.normHash = $normHash,
                s.provenance = $provenance
            MERGE (f)-[:DEFINES]->(s)
            MERGE (s)-[:BELONGS_TO]->(m)
          `,
          {
            repoId: event.repoId,
            filePath: event.filePath,
            moduleName,
            symbolId: symbol.symbolId,
            kind: symbol.kind,
            name: symbol.name,
            signature: symbol.signature ?? symbol.name,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            hash: symbol.hash,
            normHash: symbol.normHash,
            provenance: symbol.provenance ?? "unknown",
          },
        );

        for (const entry of symbol.imports ?? []) {
          const target = importTarget(event.filePath, entry);
          if (target.kind === "Package") {
            await tx.run(
              `
                MATCH (f:File {repoId: $repoId, path: $filePath})
                MERGE (p:Package {name: $name})
                MERGE (f)-[:IMPORTS]->(p)
              `,
              { repoId: event.repoId, filePath: event.filePath, name: target.id },
            );
            continue;
          }

          await tx.run(
            `
              MATCH (f:File {repoId: $repoId, path: $filePath})
              MERGE (target:File {repoId: $repoId, path: $targetPath})
              MERGE (f)-[:IMPORTS]->(target)
            `,
            { repoId: event.repoId, filePath: event.filePath, targetPath: target.id },
          );
        }
      }

      const localSymbols = new Map(event.symbols.map((symbol) => [symbol.name, symbol.symbolId]));
      for (const symbol of event.symbols) {
        for (const callName of symbol.calls ?? []) {
          const targetSymbolId = localSymbols.get(callName);
          if (!targetSymbolId || targetSymbolId === symbol.symbolId) {
            continue;
          }

          await tx.run(
            `
              MATCH (from:Symbol {repoId: $repoId, symbolId: $sourceId})
              MATCH (to:Symbol {repoId: $repoId, symbolId: $targetId})
              MERGE (from)-[:CALLS]->(to)
            `,
            {
              repoId: event.repoId,
              sourceId: symbol.symbolId,
              targetId: targetSymbolId,
            },
          );
        }
      }

      await tx.run(
        `
          MATCH (f:File {repoId: $repoId, path: $filePath})
          SET f.dependencyEdges = $dependencyEdges
        `,
        {
          repoId: event.repoId,
          filePath: event.filePath,
          dependencyEdges: nextEdges,
        },
      );
    });

    const currentEdgeRows = await session.run(
      `
        MATCH (:Module {repoId: $repoId, name: $moduleName})-[:CONTAINS]->(f:File {repoId: $repoId})
        RETURN f.dependencyEdges AS dependencyEdges
      `,
      {
        repoId: event.repoId,
        moduleName,
      },
    );

    const currentEdges = Array.from(
      new Set(
        currentEdgeRows.records.flatMap((record) => toStringArray(record.get("dependencyEdges"))),
      ),
    ).sort();

    const previousSet = new Set(previousEdges);
    const nextSet = new Set(nextEdges);

    return {
      moduleName,
      currentEdges,
      addedEdges: nextEdges.filter((edge) => !previousSet.has(edge)),
      removedEdges: previousEdges.filter((edge) => !nextSet.has(edge)),
      externalDependencyCount: currentEdges.filter((edge) => edge.startsWith(`${moduleName}->pkg:`)).length,
    };
  } finally {
    await session.close();
  }
}
