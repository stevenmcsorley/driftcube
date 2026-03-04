import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);

function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

function alertIdExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `md5(CONCAT_WS('|', ${prefix}repo_id, COALESCE(${prefix}sha, ''), ${prefix}at::text, ${prefix}type, ${prefix}title))`;
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

function listSelectFields(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  const id = alertIdExpression(alias);

  return `
    ${id} AS id,
    ${prefix}repo_id AS "repoId",
    ${prefix}at,
    ${prefix}severity,
    ${prefix}status,
    ${prefix}type,
    ${prefix}title,
    ${prefix}evidence,
    ${prefix}recommendation,
    ${prefix}sha
  `;
}

function detailSelectFields(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `
    ${listSelectFields(alias)},
    ${prefix}acknowledged_at AS "acknowledgedAt",
    ${prefix}acknowledged_by AS "acknowledgedBy",
    ${prefix}resolved_at AS "resolvedAt",
    ${prefix}resolved_by AS "resolvedBy",
    ${prefix}status_updated_at AS "statusUpdatedAt"
  `;
}

function mapAlertRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    at: toIso(row.at),
    acknowledgedAt: row.acknowledgedAt ? toIso(row.acknowledgedAt) : null,
    resolvedAt: row.resolvedAt ? toIso(row.resolvedAt) : null,
    statusUpdatedAt: row.statusUpdatedAt ? toIso(row.statusUpdatedAt) : null,
  };
}

function allowedPathPrefixes(): string[] {
  return ["/app", process.env.CONTAINER_PATH_PREFIX ?? "/host-repos"].map((entry) => path.resolve(entry));
}

function extractSearchTerms(evidence: Record<string, unknown> | undefined, title: string): string[] {
  const terms = new Set<string>();
  const symbolId = typeof evidence?.symbolId === "string" ? evidence.symbolId : null;
  const module = typeof evidence?.module === "string" ? evidence.module : null;

  if (symbolId) {
    const symbolToken = symbolId.split(":").pop() ?? symbolId;
    const functionToken = symbolToken.split(".").pop() ?? symbolToken;
    if (functionToken.length >= 3) {
      terms.add(functionToken);
    }
  }

  if (module && module.length >= 3) {
    terms.add(module);
  }

  const titleTokens = title.match(/[A-Za-z][A-Za-z0-9_]{3,}/g) ?? [];
  for (const token of titleTokens.slice(0, 6)) {
    terms.add(token);
  }

  return [...terms];
}

async function buildFilePreview(input: {
  absolutePath: string | null;
  filePath: string | null;
  evidence?: Record<string, unknown>;
  title: string;
}): Promise<{
  available: boolean;
  filePath: string | null;
  absolutePath: string | null;
  totalLines: number;
  previewStart: number;
  previewEnd: number;
  lines: Array<{ number: number; text: string; highlight: boolean }>;
  reason?: string;
}> {
  const absolutePath = input.absolutePath ? path.resolve(input.absolutePath) : null;

  if (!absolutePath) {
    return {
      available: false,
      filePath: input.filePath,
      absolutePath: null,
      totalLines: 0,
      previewStart: 0,
      previewEnd: 0,
      lines: [],
      reason: "No mounted file path was recorded for this alert.",
    };
  }

  if (!allowedPathPrefixes().some((prefix) => absolutePath.startsWith(prefix))) {
    return {
      available: false,
      filePath: input.filePath,
      absolutePath,
      totalLines: 0,
      previewStart: 0,
      previewEnd: 0,
      lines: [],
      reason: "File path is outside the mounted analysis roots.",
    };
  }

  try {
    const content = await readFile(absolutePath, "utf8");
    const rows = content.split(/\r?\n/);
    const searchTerms = extractSearchTerms(input.evidence, input.title);

    let anchorLine = 1;
    let matchedTerm: string | null = null;

    for (const term of searchTerms) {
      const rowIndex = rows.findIndex((row) => row.includes(term));
      if (rowIndex >= 0) {
        anchorLine = rowIndex + 1;
        matchedTerm = term;
        break;
      }
    }

    const previewStart = Math.max(1, anchorLine - 16);
    const previewEnd = Math.min(rows.length, previewStart + 119);
    const lines = rows.slice(previewStart - 1, previewEnd).map((text, index) => {
      const number = previewStart + index;
      return {
        number,
        text,
        highlight: Boolean(matchedTerm && text.includes(matchedTerm)),
      };
    });

    return {
      available: true,
      filePath: input.filePath,
      absolutePath,
      totalLines: rows.length,
      previewStart,
      previewEnd,
      lines,
    };
  } catch (error) {
    return {
      available: false,
      filePath: input.filePath,
      absolutePath,
      totalLines: 0,
      previewStart: 0,
      previewEnd: 0,
      lines: [],
      reason: error instanceof Error ? error.message : "Unable to read file preview.",
    };
  }
}

async function buildFileDiff(input: {
  rootPath: string | null;
  filePath: string | null;
  repoId: string;
  db: FastifyInstance["db"];
}): Promise<{
  available: boolean;
  filePath: string | null;
  lines: Array<{ kind: "context" | "add" | "remove" | "meta"; text: string }>;
  reason?: string;
}> {
  if (!input.filePath) {
    return {
      available: false,
      filePath: input.filePath,
      lines: [],
      reason: "No file path was available for diff generation.",
    };
  }

  const snapshotResult = await input.db.query<{
    content: string;
    observedAt: Date;
  }>(
    `
      SELECT content, observed_at AS "observedAt"
      FROM file_snapshots
      WHERE repo_id = $1
        AND file_path = $2
      ORDER BY observed_at DESC
      LIMIT 2
    `,
    [input.repoId, input.filePath],
  );

  if (snapshotResult.rows.length >= 2) {
    const latestSnapshot = snapshotResult.rows[0];
    const previousSnapshot = snapshotResult.rows[1];
    if (!latestSnapshot || !previousSnapshot) {
      return {
        available: false,
        filePath: input.filePath,
        lines: [],
        reason: "DriftCube could not resolve both file snapshots for this diff.",
      };
    }

    const current = latestSnapshot.content.split(/\r?\n/);
    const previous = previousSnapshot.content.split(/\r?\n/);
    let prefix = 0;
    while (prefix < current.length && prefix < previous.length && current[prefix] === previous[prefix]) {
      prefix += 1;
    }

    let currentSuffix = current.length - 1;
    let previousSuffix = previous.length - 1;
    while (currentSuffix >= prefix && previousSuffix >= prefix && current[currentSuffix] === previous[previousSuffix]) {
      currentSuffix -= 1;
      previousSuffix -= 1;
    }

    const contextStart = Math.max(0, prefix - 3);
    const lines: Array<{ kind: "context" | "add" | "remove" | "meta"; text: string }> = [];

    if (contextStart < prefix) {
      for (const line of previous.slice(contextStart, prefix)) {
        lines.push({ kind: "context", text: ` ${line}` });
      }
    }

    for (const line of previous.slice(prefix, previousSuffix + 1)) {
      lines.push({ kind: "remove", text: `-${line}` });
    }

    for (const line of current.slice(prefix, currentSuffix + 1)) {
      lines.push({ kind: "add", text: `+${line}` });
    }

    const suffixContextEnd = Math.min(current.length, currentSuffix + 4);
    for (const line of current.slice(currentSuffix + 1, suffixContextEnd)) {
      lines.push({ kind: "context", text: ` ${line}` });
    }

    if (lines.length > 0) {
      return {
        available: true,
        filePath: input.filePath,
        lines: lines.slice(0, 220),
      };
    }
  }

  if (!input.rootPath) {
    return {
      available: false,
      filePath: input.filePath,
      lines: [],
      reason: "DriftCube needs two observed file snapshots before it can render an inline diff.",
    };
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", input.rootPath, "diff", "--unified=3", "--", input.filePath],
      { maxBuffer: 1024 * 1024 },
    );
    const lines: Array<{ kind: "context" | "add" | "remove" | "meta"; text: string }> = stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(0, 220)
      .map((line) => ({
        kind: line.startsWith("+") && !line.startsWith("+++") ? "add" : (
          line.startsWith("-") && !line.startsWith("---") ? "remove" : (
            line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")
              ? "meta"
              : "context"
          )
        ),
        text: line,
      }));

    if (lines.length === 0) {
      return {
        available: false,
        filePath: input.filePath,
        lines: [],
        reason: "No current git diff is available for this file.",
      };
    }

    return {
      available: true,
      filePath: input.filePath,
      lines,
    };
  } catch (error) {
    return {
      available: false,
      filePath: input.filePath,
      lines: [],
      reason: error instanceof Error ? error.message : "Unable to compute file diff.",
    };
  }
}

export async function registerAlertRoutes(app: FastifyInstance): Promise<void> {
  app.get("/repos/:repoId/alerts", async (request) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const query = z.object({
      since: z.string().optional(),
      type: z.string().optional(),
      severity: z.string().optional(),
      status: z.enum(["open", "acknowledged", "resolved"]).optional(),
      heuristicCategory: z.string().optional(),
      page: z.coerce.number().min(1).default(1),
      limit: z.coerce.number().min(1).max(100).default(8),
    }).parse(request.query);

    const values: unknown[] = [params.repoId];
    const filters: string[] = ["repo_id = $1"];

    if (query.since) {
      values.push(query.since);
      filters.push(`at >= $${values.length}`);
    }

    if (query.type) {
      values.push(query.type);
      filters.push(`type = $${values.length}`);
    }

    if (query.severity) {
      values.push(query.severity);
      filters.push(`severity = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      filters.push(`status = $${values.length}`);
    }

    if (query.heuristicCategory) {
      values.push(query.heuristicCategory);
      filters.push(`COALESCE(evidence ->> 'heuristicCategory', '') = $${values.length}`);
    }

    const countResult = await app.db.query<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM alerts
        WHERE ${filters.join(" AND ")}
      `,
      values,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);
    const offset = (query.page - 1) * query.limit;
    const rowValues = [...values, query.limit, offset];

    const result = await app.db.query(
      `
        SELECT ${listSelectFields()}
        FROM alerts
        WHERE ${filters.join(" AND ")}
        ORDER BY at DESC
        LIMIT $${rowValues.length - 1}
        OFFSET $${rowValues.length}
      `,
      rowValues,
    );

    return {
      items: result.rows.map((row) => mapAlertRow(row)),
      total,
      page: query.page,
      pageSize: query.limit,
      totalPages: totalPages(total, query.limit),
    };
  });

  app.get("/repos/:repoId/alerts/:alertId", async (request, reply) => {
    const params = z.object({
      repoId: z.string(),
      alertId: z.string().min(1),
    }).parse(request.params);

    const alertResult = await app.db.query(
      `
        SELECT ${detailSelectFields()}
        FROM alerts
        WHERE repo_id = $1
          AND ${alertIdExpression()} = $2
        LIMIT 1
      `,
      [params.repoId, params.alertId],
    );

    const alert = alertResult.rows[0];
    if (!alert) {
      reply.code(404);
      return { error: "alert not found" };
    }

    const evidence = typeof alert.evidence === "object" && alert.evidence ? alert.evidence as Record<string, unknown> : {};
    const filePath = typeof evidence.filePath === "string" ? evidence.filePath : null;
    const moduleId = typeof evidence.module === "string" ? evidence.module : null;

    const activityHistoryResult = filePath
      ? await app.db.query(
        `
          SELECT
            event_id AS "eventId",
            repo_id AS "repoId",
            commit_sha AS "commitSha",
            at,
            file_path AS "filePath",
            absolute_path AS "absolutePath",
            language,
            change_type AS "changeType",
            parser_status AS "parserStatus",
            symbol_count AS "symbolCount",
            alert_count AS "alertCount",
            provenance,
            telemetry_source AS "telemetrySource",
            telemetry_editor AS "telemetryEditor",
            telemetry_session_id AS "telemetrySessionId",
            note,
            updated_at AS "updatedAt"
          FROM surface_activity
          WHERE repo_id = $1
            AND file_path = $2
          ORDER BY at DESC
          LIMIT 12
        `,
        [params.repoId, filePath],
      )
      : { rows: [] };

    const relatedAlertsResult = filePath
      ? await app.db.query(
        `
          SELECT ${listSelectFields()}
          FROM alerts
          WHERE repo_id = $1
            AND COALESCE(evidence ->> 'filePath', '') = $2
            AND ${alertIdExpression()} <> $3
          ORDER BY at DESC
          LIMIT 6
        `,
        [params.repoId, filePath, params.alertId],
      )
      : { rows: [] };

    const relatedRefactorsResult = await app.db.query(
      `
        SELECT
          id,
          repo_id AS "repoId",
          at,
          scope,
          target,
          type,
          confidence,
          impact,
          evidence,
          plan,
          status,
          simulation,
          EXISTS (
            SELECT 1
            FROM alert_refactor_links l
            WHERE l.repo_id = refactor_suggestions.repo_id
              AND l.refactor_id = refactor_suggestions.id
              AND l.alert_id = $4
          ) AS "linkedToAlert"
        FROM refactor_suggestions
        WHERE repo_id = $1
          AND (
            ($2::text IS NOT NULL AND (
              target = $2
              OR COALESCE(evidence -> 'entities' -> 'files', '[]'::jsonb) @> to_jsonb(ARRAY[$2]::text[])
            ))
            OR ($3::text IS NOT NULL AND (
              target = $3
              OR COALESCE(evidence -> 'entities' -> 'modules', '[]'::jsonb) @> to_jsonb(ARRAY[$3]::text[])
            ))
          )
        ORDER BY
          CASE status
            WHEN 'applied' THEN 0
            WHEN 'accepted' THEN 1
            WHEN 'proposed' THEN 2
            ELSE 3
          END,
          at DESC
        LIMIT 6
      `,
      [params.repoId, filePath, moduleId, params.alertId],
    );

    const commentResult = await app.db.query(
      `
        SELECT id, repo_id AS "repoId", alert_id AS "alertId", kind, author, body, created_at AS "createdAt"
        FROM alert_comments
        WHERE repo_id = $1
          AND alert_id = $2
        ORDER BY created_at DESC
      `,
      [params.repoId, params.alertId],
    );

    const repoPathResult = filePath
      ? await app.db.query<{ rootPath: string | null }>(
        `
          SELECT root_path AS "rootPath"
          FROM repos
          WHERE repo_id = $1
          LIMIT 1
        `,
        [params.repoId],
      )
      : { rows: [] };
    const fallbackAbsolutePath = (
      activityHistoryResult.rows[0]?.absolutePath
      ?? (repoPathResult.rows[0]?.rootPath && filePath ? path.join(repoPathResult.rows[0].rootPath, filePath) : null)
    );

    const preview = await buildFilePreview({
      absolutePath: fallbackAbsolutePath,
      filePath,
      evidence,
      title: String(alert.title),
    });
    const diff = await buildFileDiff({
      repoId: params.repoId,
      db: app.db,
      rootPath: repoPathResult.rows[0]?.rootPath ?? null,
      filePath,
    });

    return {
      alert: mapAlertRow(alert),
      preview,
      diff,
      activityHistory: activityHistoryResult.rows.map((row) => ({
        ...row,
        at: toIso(row.at),
        updatedAt: toIso(row.updatedAt),
      })),
      relatedAlerts: relatedAlertsResult.rows.map((row) => ({
        ...row,
        at: toIso(row.at),
      })),
      relatedRefactors: relatedRefactorsResult.rows.map((row) => ({
        ...row,
        at: toIso(row.at),
      })),
      comments: commentResult.rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
      })),
    };
  });

  app.patch("/repos/:repoId/alerts/:alertId", async (request, reply) => {
    const params = z.object({
      repoId: z.string(),
      alertId: z.string().min(1),
    }).parse(request.params);
    const body = z.object({
      status: z.enum(["open", "acknowledged", "resolved"]),
      actor: z.string().trim().min(1).max(64).default("operator"),
      note: z.string().trim().max(4000).optional(),
    }).parse(request.body);

    const current = await app.db.query(
      `
        SELECT ${detailSelectFields()}
        FROM alerts
        WHERE repo_id = $1
          AND ${alertIdExpression()} = $2
        LIMIT 1
      `,
      [params.repoId, params.alertId],
    );

    if ((current.rowCount ?? 0) === 0) {
      reply.code(404);
      return { error: "alert not found" };
    }

    await app.db.query(
      `
        UPDATE alerts
        SET
          status = $3,
          acknowledged_at = CASE
            WHEN $3 = 'acknowledged' AND acknowledged_at IS NULL THEN NOW()
            WHEN $3 = 'open' THEN NULL
            ELSE acknowledged_at
          END,
          acknowledged_by = CASE
            WHEN $3 = 'acknowledged' AND acknowledged_by IS NULL THEN $4
            WHEN $3 = 'open' THEN NULL
            ELSE acknowledged_by
          END,
          resolved_at = CASE
            WHEN $3 = 'resolved' THEN NOW()
            WHEN $3 <> 'resolved' THEN NULL
            ELSE resolved_at
          END,
          resolved_by = CASE
            WHEN $3 = 'resolved' THEN $4
            WHEN $3 <> 'resolved' THEN NULL
            ELSE resolved_by
          END,
          status_updated_at = NOW()
        WHERE repo_id = $1
          AND ${alertIdExpression()} = $2
      `,
      [params.repoId, params.alertId, body.status, body.actor],
    );

    const label = body.status === "acknowledged"
      ? "Acknowledged"
      : body.status === "resolved"
        ? "Resolved"
        : "Reopened";

    const commentBody = body.note?.trim()
      ? `${label} by ${body.actor}. ${body.note.trim()}`
      : `${label} by ${body.actor}.`;

    await app.db.query(
      `
        INSERT INTO alert_comments (id, repo_id, alert_id, kind, author, body)
        VALUES ($1, $2, $3, 'note', $4, $5)
      `,
      [`comment_${randomUUID()}`, params.repoId, params.alertId, "driftcube", commentBody],
    );

    const updated = await app.db.query(
      `
        SELECT ${detailSelectFields()}
        FROM alerts
        WHERE repo_id = $1
          AND ${alertIdExpression()} = $2
        LIMIT 1
      `,
      [params.repoId, params.alertId],
    );

    return {
      item: mapAlertRow(updated.rows[0] ?? {}),
      updatedAt: new Date().toISOString(),
    };
  });

  app.post("/repos/:repoId/alerts/:alertId/link-refactor", async (request, reply) => {
    const params = z.object({
      repoId: z.string(),
      alertId: z.string().min(1),
    }).parse(request.params);
    const body = z.object({
      refactorId: z.string().min(1),
      linkedBy: z.string().trim().min(1).max(64).default("operator"),
    }).parse(request.body);

    const [alertResult, refactorResult] = await Promise.all([
      app.db.query(
        `
          SELECT ${listSelectFields()}
          FROM alerts
          WHERE repo_id = $1
            AND ${alertIdExpression()} = $2
          LIMIT 1
        `,
        [params.repoId, params.alertId],
      ),
      app.db.query(
        `
          SELECT id, target, type, status
          FROM refactor_suggestions
          WHERE repo_id = $1
            AND id = $2
          LIMIT 1
        `,
        [params.repoId, body.refactorId],
      ),
    ]);

    if ((alertResult.rowCount ?? 0) === 0) {
      reply.code(404);
      return { error: "alert not found" };
    }

    if ((refactorResult.rowCount ?? 0) === 0) {
      reply.code(404);
      return { error: "refactor not found" };
    }

    await app.db.query(
      `
        INSERT INTO alert_refactor_links (id, repo_id, alert_id, refactor_id, linked_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (repo_id, alert_id, refactor_id)
        DO NOTHING
      `,
      [`alert_refactor_link_${randomUUID()}`, params.repoId, params.alertId, body.refactorId, body.linkedBy],
    );

    await app.db.query(
      `
        INSERT INTO alert_comments (id, repo_id, alert_id, kind, author, body)
        VALUES ($1, $2, $3, 'improvement', 'driftcube', $4)
      `,
      [
        `comment_${randomUUID()}`,
        params.repoId,
        params.alertId,
        `Linked refactor ${String(refactorResult.rows[0]?.type ?? "REFRACTOR")} (${String(refactorResult.rows[0]?.target ?? body.refactorId)}) to this alert.`,
      ],
    );

    return {
      linked: true,
      refactorId: body.refactorId,
      alertId: params.alertId,
    };
  });

  app.post("/repos/:repoId/alerts/:alertId/comments", async (request) => {
    const params = z.object({
      repoId: z.string(),
      alertId: z.string().min(1),
    }).parse(request.params);
    const body = z.object({
      kind: z.enum(["note", "fix", "improvement"]).default("note"),
      author: z.string().trim().min(1).max(64).default("operator"),
      body: z.string().trim().min(1).max(4000),
    }).parse(request.body);

    const id = `comment_${randomUUID()}`;
    const result = await app.db.query(
      `
        INSERT INTO alert_comments (id, repo_id, alert_id, kind, author, body)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, repo_id AS "repoId", alert_id AS "alertId", kind, author, body, created_at AS "createdAt"
      `,
      [id, params.repoId, params.alertId, body.kind, body.author, body.body],
    );

    return {
      item: {
        ...result.rows[0],
        createdAt: toIso(result.rows[0].createdAt),
      },
    };
  });

  app.get("/alerts", async (request) => {
    const query = z.object({
      repoId: z.string().optional(),
      since: z.string().optional(),
      type: z.string().optional(),
      severity: z.string().optional(),
      status: z.enum(["open", "acknowledged", "resolved"]).optional(),
      heuristicCategory: z.string().optional(),
      page: z.coerce.number().min(1).default(1),
      limit: z.coerce.number().min(1).max(100).default(12),
    }).parse(request.query);

    const values: unknown[] = [];
    const filters: string[] = [];

    if (query.repoId) {
      values.push(query.repoId);
      filters.push(`repo_id = $${values.length}`);
    }

    if (query.since) {
      values.push(query.since);
      filters.push(`at >= $${values.length}`);
    }

    if (query.type) {
      values.push(query.type);
      filters.push(`type = $${values.length}`);
    }

    if (query.severity) {
      values.push(query.severity);
      filters.push(`severity = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      filters.push(`status = $${values.length}`);
    }

    if (query.heuristicCategory) {
      values.push(query.heuristicCategory);
      filters.push(`COALESCE(evidence ->> 'heuristicCategory', '') = $${values.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const countResult = await app.db.query<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM alerts
        ${whereClause}
      `,
      values,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);
    const offset = (query.page - 1) * query.limit;
    const rowValues = [...values, query.limit, offset];
    const result = await app.db.query(
      `
        SELECT ${listSelectFields()}
        FROM alerts
        ${whereClause}
        ORDER BY at DESC
        LIMIT $${rowValues.length - 1}
        OFFSET $${rowValues.length}
      `,
      rowValues,
    );

    return {
      items: result.rows.map((row) => mapAlertRow(row)),
      total,
      page: query.page,
      pageSize: query.limit,
      totalPages: totalPages(total, query.limit),
    };
  });

  app.get("/repos/:repoId/alerts/latest", async (request) => {
    const params = z.object({ repoId: z.string() }).parse(request.params);
    const result = await app.db.query(
      `
        SELECT ${listSelectFields()}
        FROM alerts
        WHERE repo_id = $1
        ORDER BY at DESC
        LIMIT 25
      `,
      [params.repoId],
    );

    return result.rows.map((row) => ({
      ...mapAlertRow(row),
    }));
  });
}
