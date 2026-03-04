import { Subjects, deriveModuleName, publishJson, subscribeJson, type GraphUpdated, type SymbolsExtracted } from "@driftcube/shared";
import type { NatsConnection } from "nats";
import { createLogger } from "@driftcube/shared";
import type neo4j from "neo4j-driver";
import { upsertGraph } from "./upsert.js";

const logger = createLogger("graph");

export function startGraphWorker(nc: NatsConnection, driver: neo4j.Driver): void {
  subscribeJson<SymbolsExtracted>(nc, Subjects.SymbolsExtracted, async (event) => {
    const summary = await upsertGraph(driver, event);

    const graphUpdated: GraphUpdated = {
      schemaVersion: 1,
      repoId: event.repoId,
      commitSha: event.commitSha,
      filePath: event.filePath,
      moduleName: deriveModuleName(event.filePath),
      moduleDependencyCount: summary.currentEdges.length,
      externalDependencyCount: summary.externalDependencyCount,
      graphEdgesAdded: summary.addedEdges,
      graphEdgesRemoved: summary.removedEdges,
      graphEdgesCurrent: summary.currentEdges,
      symbols: event.symbols.map((symbol) => ({
        symbolId: symbol.symbolId,
        name: symbol.name,
      })),
    };

    logger.info("graph updated", {
      repoId: event.repoId,
      filePath: event.filePath,
      symbolCount: event.symbols.length,
      dependencyCount: summary.currentEdges.length,
    });
    await publishJson(nc, Subjects.GraphUpdated, graphUpdated);
  });
}
