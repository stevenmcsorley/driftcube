import type neo4j from "neo4j-driver";

export interface ArchitectureViolation {
  sourcePath: string;
  targetPath: string;
  rule: string;
}

export async function findArchitectureViolations(
  driver: neo4j.Driver,
  repoId: string,
): Promise<ArchitectureViolation[]> {
  const session = driver.session();

  try {
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
      { repoId },
    );

    return result.records.map((record) => ({
      sourcePath: String(record.get("sourcePath")),
      targetPath: String(record.get("targetPath")),
      rule: "domain must not import web or infra",
    }));
  } finally {
    await session.close();
  }
}

