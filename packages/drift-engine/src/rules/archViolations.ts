import type neo4j from "neo4j-driver";
import type { AlertRaised, GraphUpdated } from "@driftcube/shared";

export async function detectArchitectureViolations(
  driver: neo4j.Driver,
  event: GraphUpdated,
): Promise<AlertRaised[]> {
  const session = driver.session();
  const result = await session.run(
    `
      MATCH (source:File {repoId: $repoId})-[:IMPORTS]->(target:File {repoId: $repoId})
      WHERE source.path STARTS WITH "src/domain/"
        AND (
          target.path STARTS WITH "src/web/"
          OR target.path STARTS WITH "src/infra/"
        )
      RETURN source.path AS sourcePath, target.path AS targetPath
    `,
    { repoId: event.repoId },
  );
  await session.close();

  const violations = result.records.map((record) => ({
    sourcePath: String(record.get("sourcePath")),
    targetPath: String(record.get("targetPath")),
    rule: "domain must not import web or infra",
  }));

  return violations.map((violation) => ({
    schemaVersion: 1,
    repoId: event.repoId,
    commitSha: event.commitSha,
    at: new Date().toISOString(),
    severity: "error",
    type: "ARCH_VIOLATION",
    title: `Architecture boundary violated: ${violation.rule}`,
    evidence: {
      filePath: violation.sourcePath,
      graphEdgesAdded: [`${violation.sourcePath} -> ${violation.targetPath}`],
    },
    recommendation: "Move the import behind an allowed boundary or introduce an adapter.",
  }));
}
