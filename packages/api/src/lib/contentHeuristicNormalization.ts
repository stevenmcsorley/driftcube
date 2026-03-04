import type { Pool } from "pg";

function parseDrivers(recommendation: string | null | undefined): string[] {
  if (!recommendation) {
    return [];
  }

  const separator = recommendation.indexOf(":");
  if (separator === -1) {
    return [];
  }

  return recommendation
    .slice(separator + 1)
    .split(",")
    .map((entry) => entry.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

function inferCategory(drivers: string[], filePath: string | null | undefined): string {
  const normalized = drivers.map((driver) => driver.toLowerCase());
  const lowerPath = (filePath ?? "").toLowerCase();

  if (normalized.some((driver) => driver.includes("fake secret") || driver.includes("fake credential"))) {
    return "SECRET_PLACEHOLDER";
  }

  if (normalized.some((driver) => driver.includes("local/example endpoint"))) {
    return "LOCAL_ENDPOINT";
  }

  if (normalized.some((driver) => driver.includes("debug mode enabled"))) {
    return "DEBUG_CONFIG";
  }

  if (normalized.some((driver) => driver.includes("unpinned action ref") || driver.includes("continue-on-error"))) {
    return "WORKFLOW_RISK";
  }

  if (normalized.some((driver) => driver.includes("base image latest") || driver.includes("container runs as root") || driver.includes("pipe-to-shell"))) {
    return "CONTAINER_RISK";
  }

  if (normalized.some((driver) => driver.includes("!important") || driver.includes("z-index") || driver.includes("styling"))) {
    return "STYLING_OVERRIDE";
  }

  if (normalized.some((driver) => driver.includes("placeholder") || driver.includes("template") || driver.includes("todo"))) {
    return "PLACEHOLDER_CONTENT";
  }

  if (lowerPath.includes(".github/workflows/") || lowerPath.endsWith(".gitlab-ci.yml")) {
    return "WORKFLOW_RISK";
  }

  if (lowerPath.endsWith("dockerfile")) {
    return "CONTAINER_RISK";
  }

  if (lowerPath.endsWith(".env") || lowerPath.includes(".env.")) {
    return "DEBUG_CONFIG";
  }

  return "CONTENT_DRIFT";
}

export async function normalizeLegacyContentHeuristics(pool: Pool): Promise<number> {
  const result = await pool.query<{
    repoId: string;
    sha: string;
    at: Date | string;
    title: string;
    evidence: Record<string, unknown> | null;
    recommendation: string | null;
  }>(
    `
      SELECT
        repo_id AS "repoId",
        sha,
        at,
        title,
        evidence,
        recommendation
      FROM alerts
      WHERE type = 'CONTENT_HEURISTIC'
        AND COALESCE(evidence ->> 'heuristicCategory', '') = ''
      ORDER BY at ASC
    `,
  );

  let updated = 0;
  for (const row of result.rows) {
    const evidence = row.evidence && typeof row.evidence === "object" ? { ...row.evidence } : {};
    const filePath = typeof evidence.filePath === "string"
      ? evidence.filePath
      : row.title.replace(/^Non-code content drift detected in\s+/i, "").trim();
    const heuristicDrivers = Array.isArray(evidence.heuristicDrivers)
      ? evidence.heuristicDrivers.filter((value): value is string => typeof value === "string")
      : parseDrivers(row.recommendation);
    const heuristicCategory = inferCategory(heuristicDrivers, filePath);

    await pool.query(
      `
        UPDATE alerts
        SET evidence = $5::jsonb
        WHERE repo_id = $1
          AND sha = $2
          AND at = $3
          AND title = $4
      `,
      [
        row.repoId,
        row.sha,
        row.at,
        row.title,
        JSON.stringify({
          ...evidence,
          filePath,
          heuristicDrivers,
          heuristicCategory,
        }),
      ],
    );
    updated += 1;
  }

  return updated;
}
