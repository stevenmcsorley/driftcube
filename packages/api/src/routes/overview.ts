import type { FastifyInstance } from "fastify";

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function classifyPattern(input: {
  pressureIndex: number;
  entropyIndex: number;
  alertCount: number;
  archSignalCount: number;
  duplicationSignalCount: number;
  volatilitySignalCount: number;
}) {
  const signals = [
    { label: "Boundary Pressure", score: input.archSignalCount + (input.pressureIndex / 25) },
    { label: "Duplication Drift", score: input.duplicationSignalCount + (input.entropyIndex / 30) },
    { label: "Volatility Hotspots", score: input.volatilitySignalCount + (input.pressureIndex / 30) },
  ].sort((left, right) => right.score - left.score);

  if (input.pressureIndex < 35 && input.entropyIndex < 35 && input.alertCount < 3) {
    return {
      label: "Stable Core",
      dominantSignals: ["low entropy", "low pressure"],
    };
  }

  const primary = signals[0];
  const dominantSignals = signals.filter((signal) => signal.score > 0.5).slice(0, 2).map((signal) => signal.label);

  if (!primary || primary.score <= 0.5) {
    return {
      label: "Mixed Drift",
      dominantSignals: ["pressure spread", "entropy spread"],
    };
  }

  return {
    label: primary.label,
    dominantSignals: dominantSignals.length > 0 ? dominantSignals : [primary.label],
  };
}

export async function registerOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/overview", async () => {
    const repos = await app.db.query(
      `
        SELECT
          r.repo_id AS "repoId",
          r.name,
          r.kind,
          r.root_path AS "rootPath",
          r.remote_url AS "remoteUrl",
          r.default_branch AS "defaultBranch",
          latest_entropy.value AS "entropyIndex",
          latest_pressure.value AS "pressureIndex",
          COALESCE(activity_coverage.activity_24h, 0) AS "activity24h",
          COALESCE(activity_coverage.analyzable_events, 0) AS "analyzableEvents24h",
          COALESCE(activity_coverage.analyzed_events, 0) AS "analyzedEvents24h",
          COALESCE(activity_coverage.unsupported_events, 0) AS "unsupportedEvents24h",
          COALESCE(activity_coverage.coverage_percent, 0) AS "analysisCoveragePercent",
          r.created_at AS "createdAt",
          COALESCE(component_counts.component_count, 0) AS "componentCount",
          latest_alert.severity AS "latestSeverity",
          latest_alert.at AS "latestAlertAt",
          COALESCE(alert_counts.alert_count, 0) AS "alertCount"
        FROM repos r
        LEFT JOIN (
          SELECT repo_id, COUNT(DISTINCT COALESCE(tags ->> 'module', 'root'))::int AS component_count
          FROM metrics
          GROUP BY repo_id
        ) component_counts
          ON component_counts.repo_id = r.repo_id
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, severity, at
          FROM alerts
          ORDER BY repo_id, at DESC
        ) latest_alert
          ON latest_alert.repo_id = r.repo_id
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, value
          FROM metrics
          WHERE scope = 'repo'
            AND key = 'code_entropy_index'
          ORDER BY repo_id, at DESC
        ) latest_entropy
          ON latest_entropy.repo_id = r.repo_id
        LEFT JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, value
          FROM metrics
          WHERE scope = 'repo'
            AND key = 'pressure_index'
          ORDER BY repo_id, at DESC
        ) latest_pressure
          ON latest_pressure.repo_id = r.repo_id
        LEFT JOIN (
          SELECT repo_id, COUNT(*)::int AS alert_count
          FROM alerts
          WHERE at >= NOW() - INTERVAL '24 hours'
          GROUP BY repo_id
        ) alert_counts
          ON alert_counts.repo_id = r.repo_id
        LEFT JOIN (
          SELECT
            repo_id,
            COUNT(*)::int AS activity_24h,
            COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::int AS analyzable_events,
            COUNT(*) FILTER (WHERE parser_status = 'analyzed')::int AS analyzed_events,
            COUNT(*) FILTER (WHERE parser_status = 'unsupported')::int AS unsupported_events,
            ROUND(
              (
                COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::numeric
                / NULLIF(COUNT(*), 0)
              ) * 100,
              1
            ) AS coverage_percent
          FROM surface_activity
          WHERE at >= NOW() - INTERVAL '24 hours'
          GROUP BY repo_id
        ) activity_coverage
          ON activity_coverage.repo_id = r.repo_id
        WHERE r.archived_at IS NULL
        ORDER BY COALESCE(latest_alert.at, r.created_at) DESC
      `,
    );

    const recentAlerts = await app.db.query(
      `
        SELECT
          alerts.repo_id AS "repoId",
          sha,
          at,
          severity,
          type,
          title,
          evidence,
          recommendation
        FROM alerts
        INNER JOIN repos
          ON repos.repo_id = alerts.repo_id
         AND repos.archived_at IS NULL
        ORDER BY at DESC
        LIMIT 16
      `,
    );

    const recentActivity = await app.db.query(
      `
        SELECT
          a.event_id AS "eventId",
          a.repo_id AS "repoId",
          r.name AS "repoName",
          a.commit_sha AS "commitSha",
          a.at,
          a.file_path AS "filePath",
          a.absolute_path AS "absolutePath",
          a.language,
          a.change_type AS "changeType",
          a.parser_status AS "parserStatus",
          a.symbol_count AS "symbolCount",
          a.alert_count AS "alertCount",
          a.note,
          a.updated_at AS "updatedAt"
        FROM surface_activity a
        INNER JOIN repos r
          ON r.repo_id = a.repo_id
         AND r.archived_at IS NULL
        ORDER BY a.at DESC
        LIMIT 14
      `,
    );

    const languageCoverage = await app.db.query(
      `
        SELECT
          COALESCE(language, 'unknown') AS language,
          COUNT(*)::int AS "totalEvents",
          COUNT(*) FILTER (WHERE parser_status = 'unsupported')::int AS "watchedOnlyEvents",
          COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::int AS "fullPipelineEvents",
          COUNT(*) FILTER (WHERE parser_status = 'analyzed')::int AS "analyzedEvents",
          ROUND(
            (
              COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::numeric
              / NULLIF(COUNT(*), 0)
            ) * 100,
            1
          ) AS "coveragePercent"
        FROM surface_activity
        INNER JOIN repos
          ON repos.repo_id = surface_activity.repo_id
         AND repos.archived_at IS NULL
        WHERE at >= NOW() - INTERVAL '24 hours'
        GROUP BY COALESCE(language, 'unknown')
        ORDER BY "watchedOnlyEvents" DESC, "totalEvents" DESC, language ASC
        LIMIT 10
      `,
    );

    const languageTrendRows = await app.db.query<{
      language: string;
      at: string;
      watchedOnlyEvents: number;
      totalEvents: number;
      fullPipelineEvents: number;
    }>(
      `
        WITH ranked_languages AS (
          SELECT
            COALESCE(language, 'unknown') AS language
          FROM surface_activity
          INNER JOIN repos
            ON repos.repo_id = surface_activity.repo_id
           AND repos.archived_at IS NULL
          WHERE at >= NOW() - INTERVAL '24 hours'
          GROUP BY COALESCE(language, 'unknown')
          ORDER BY
            COUNT(*) FILTER (WHERE parser_status = 'unsupported') DESC,
            COUNT(*) DESC,
            COALESCE(language, 'unknown') ASC
          LIMIT 6
        ),
        buckets AS (
          SELECT generate_series(
            date_trunc('hour', NOW() - INTERVAL '23 hours'),
            date_trunc('hour', NOW()),
            INTERVAL '1 hour'
          ) AS bucket
        )
        SELECT
          ranked_languages.language,
          buckets.bucket AS at,
          COUNT(surface_activity.*) FILTER (WHERE surface_activity.parser_status = 'unsupported')::int AS "watchedOnlyEvents",
          COUNT(surface_activity.*)::int AS "totalEvents",
          COUNT(surface_activity.*) FILTER (
            WHERE surface_activity.parser_status IN ('pending', 'analyzed', 'no_symbols')
          )::int AS "fullPipelineEvents"
        FROM ranked_languages
        CROSS JOIN buckets
        LEFT JOIN surface_activity
          ON COALESCE(surface_activity.language, 'unknown') = ranked_languages.language
         AND EXISTS (
           SELECT 1
           FROM repos
           WHERE repos.repo_id = surface_activity.repo_id
             AND repos.archived_at IS NULL
         )
         AND surface_activity.at >= buckets.bucket
         AND surface_activity.at < buckets.bucket + INTERVAL '1 hour'
        GROUP BY ranked_languages.language, buckets.bucket
        ORDER BY ranked_languages.language ASC, buckets.bucket ASC
      `,
    );

    const patternSignals = await app.db.query<{
      repoId: string;
      archSignalCount: number;
      duplicationSignalCount: number;
      volatilitySignalCount: number;
    }>(
      `
        SELECT
          alerts.repo_id AS "repoId",
          COUNT(*) FILTER (WHERE type IN ('ARCH_PRESSURE', 'ARCH_VIOLATION', 'ARCH_EMBED_DRIFT'))::int AS "archSignalCount",
          COUNT(*) FILTER (WHERE type = 'SEMANTIC_DUPLICATION')::int AS "duplicationSignalCount",
          COUNT(*) FILTER (WHERE type = 'VOLATILITY_ZONE')::int AS "volatilitySignalCount"
        FROM alerts
        INNER JOIN repos
          ON repos.repo_id = alerts.repo_id
         AND repos.archived_at IS NULL
        WHERE at >= NOW() - INTERVAL '7 days'
        GROUP BY alerts.repo_id
      `,
    );

    const stats = await app.db.query(
      `
        SELECT
          (SELECT COUNT(*)::int FROM repos WHERE archived_at IS NULL) AS "repoCount",
          (
            SELECT COUNT(*)::int
            FROM alerts
            INNER JOIN repos ON repos.repo_id = alerts.repo_id
            WHERE repos.archived_at IS NULL
              AND alerts.at >= NOW() - INTERVAL '24 hours'
          ) AS "alerts24h",
          (
            SELECT COUNT(*)::int
            FROM alerts
            INNER JOIN repos ON repos.repo_id = alerts.repo_id
            WHERE repos.archived_at IS NULL
              AND alerts.severity = 'error'
              AND alerts.at >= NOW() - INTERVAL '24 hours'
          ) AS "critical24h",
          (
            SELECT COUNT(*)::int
            FROM metrics
            INNER JOIN repos ON repos.repo_id = metrics.repo_id
            WHERE repos.archived_at IS NULL
              AND metrics.at >= NOW() - INTERVAL '24 hours'
          ) AS "signals24h",
          (
            SELECT ROUND(AVG(value)::numeric, 2)
            FROM (
              SELECT DISTINCT ON (metrics.repo_id) metrics.repo_id AS repo_id, metrics.value AS value
              FROM metrics
              INNER JOIN repos ON repos.repo_id = metrics.repo_id
              WHERE scope = 'repo'
                AND key = 'code_entropy_index'
                AND repos.archived_at IS NULL
              ORDER BY metrics.repo_id, metrics.at DESC
            ) latest_repo_entropy
          ) AS "avgEntropy",
          (
            SELECT ROUND(AVG(value)::numeric, 2)
            FROM (
              SELECT DISTINCT ON (metrics.repo_id) metrics.repo_id AS repo_id, metrics.value AS value
              FROM metrics
              INNER JOIN repos ON repos.repo_id = metrics.repo_id
              WHERE scope = 'repo'
                AND key = 'pressure_index'
                AND repos.archived_at IS NULL
              ORDER BY metrics.repo_id, metrics.at DESC
            ) latest_repo_pressure
          ) AS "avgPressure",
          (
            SELECT ROUND(MAX(value)::numeric, 2)
            FROM (
              SELECT DISTINCT ON (metrics.repo_id) metrics.repo_id AS repo_id, metrics.value AS value
              FROM metrics
              INNER JOIN repos ON repos.repo_id = metrics.repo_id
              WHERE scope = 'repo'
                AND key = 'code_entropy_index'
                AND repos.archived_at IS NULL
              ORDER BY metrics.repo_id, metrics.at DESC
            ) latest_repo_entropy
          ) AS "maxEntropy"
          ,
          (
            SELECT ROUND(MAX(value)::numeric, 2)
            FROM (
              SELECT DISTINCT ON (metrics.repo_id) metrics.repo_id AS repo_id, metrics.value AS value
              FROM metrics
              INNER JOIN repos ON repos.repo_id = metrics.repo_id
              WHERE scope = 'repo'
                AND key = 'pressure_index'
                AND repos.archived_at IS NULL
              ORDER BY metrics.repo_id, metrics.at DESC
            ) latest_repo_pressure
          ) AS "maxPressure",
          (
            SELECT ROUND(AVG(coverage_percent)::numeric, 1)
            FROM (
              SELECT
                surface_activity.repo_id AS repo_id,
                ROUND(
                  (
                    COUNT(*) FILTER (WHERE parser_status IN ('pending', 'analyzed', 'no_symbols'))::numeric
                    / NULLIF(COUNT(*), 0)
                  ) * 100,
                  1
                ) AS coverage_percent
              FROM surface_activity
              INNER JOIN repos ON repos.repo_id = surface_activity.repo_id
              WHERE at >= NOW() - INTERVAL '24 hours'
                AND repos.archived_at IS NULL
              GROUP BY surface_activity.repo_id
            ) coverage_rollup
          ) AS "avgCoverage",
          (
            SELECT COUNT(*)::int
            FROM surface_activity
            INNER JOIN repos ON repos.repo_id = surface_activity.repo_id
            WHERE at >= NOW() - INTERVAL '24 hours'
              AND repos.archived_at IS NULL
          ) AS "activity24h",
          (
            SELECT COUNT(*)::int
            FROM surface_activity
            INNER JOIN repos ON repos.repo_id = surface_activity.repo_id
            WHERE at >= NOW() - INTERVAL '24 hours'
              AND parser_status = 'unsupported'
              AND repos.archived_at IS NULL
          ) AS "watchedOnly24h"
      `,
    );

    const signalIndex = new Map(patternSignals.rows.map((row) => [row.repoId, row]));
    const patternGroups = new Map<string, {
      label: string;
      repoCount: number;
      avgEntropy: number;
      avgPressure: number;
      dominantSignals: string[];
      repos: Array<{ repoId: string; name: string }>;
    }>();

    for (const repo of repos.rows) {
      const repoId = String(repo.repoId ?? "");
      const signalRow = signalIndex.get(repoId);
      const classification = classifyPattern({
        pressureIndex: toNumber(repo.pressureIndex),
        entropyIndex: toNumber(repo.entropyIndex),
        alertCount: toNumber(repo.alertCount),
        archSignalCount: toNumber(signalRow?.archSignalCount),
        duplicationSignalCount: toNumber(signalRow?.duplicationSignalCount),
        volatilitySignalCount: toNumber(signalRow?.volatilitySignalCount),
      });
      const group = patternGroups.get(classification.label) ?? {
        label: classification.label,
        repoCount: 0,
        avgEntropy: 0,
        avgPressure: 0,
        dominantSignals: classification.dominantSignals,
        repos: [],
      };

      group.repoCount += 1;
      group.avgEntropy += toNumber(repo.entropyIndex);
      group.avgPressure += toNumber(repo.pressureIndex);
      group.repos.push({
        repoId,
        name: String(repo.name ?? repoId),
      });
      patternGroups.set(classification.label, group);
    }

    const patterns = Array.from(patternGroups.values())
      .map((group) => ({
        ...group,
        avgEntropy: Number((group.avgEntropy / Math.max(group.repoCount, 1)).toFixed(2)),
        avgPressure: Number((group.avgPressure / Math.max(group.repoCount, 1)).toFixed(2)),
      }))
      .sort((left, right) => (
        (right.avgPressure + right.avgEntropy + right.repoCount * 6)
        - (left.avgPressure + left.avgEntropy + left.repoCount * 6)
      ));

    const languageWatchTrendMap = languageTrendRows.rows.reduce((acc, row) => {
        const language = String(row.language ?? "unknown");
        const current = acc.get(language) ?? {
          language,
          totalWatchedOnlyEvents: 0,
          totalEvents: 0,
          points: [] as Array<{
            at: string;
            watchedOnlyEvents: number;
            totalEvents: number;
            fullPipelineEvents: number;
            watchedOnlyPercent: number;
          }>,
        };
        const watchedOnlyEvents = toNumber(row.watchedOnlyEvents);
        const totalEvents = toNumber(row.totalEvents);
        const fullPipelineEvents = toNumber(row.fullPipelineEvents);

        current.totalWatchedOnlyEvents += watchedOnlyEvents;
        current.totalEvents += totalEvents;
        current.points.push({
          at: String(row.at),
          watchedOnlyEvents,
          totalEvents,
          fullPipelineEvents,
          watchedOnlyPercent: totalEvents === 0 ? 0 : Number(((watchedOnlyEvents / totalEvents) * 100).toFixed(1)),
        });
        acc.set(language, current);
        return acc;
      }, new Map<string, {
        language: string;
        totalWatchedOnlyEvents: number;
        totalEvents: number;
        points: Array<{
          at: string;
          watchedOnlyEvents: number;
          totalEvents: number;
          fullPipelineEvents: number;
          watchedOnlyPercent: number;
        }>;
      }>());

    const languageWatchTrends = Array.from(languageWatchTrendMap.values())
      .map((entry) => ({
        language: entry.language,
        totalWatchedOnlyEvents: entry.totalWatchedOnlyEvents,
        totalEvents: entry.totalEvents,
        points: entry.points,
      }))
      .sort((left, right) => (
        right.totalWatchedOnlyEvents - left.totalWatchedOnlyEvents
      ) || (
        right.totalEvents - left.totalEvents
      ) || left.language.localeCompare(right.language));

    return {
      stats: stats.rows[0] ?? {
        repoCount: 0,
        alerts24h: 0,
        critical24h: 0,
        signals24h: 0,
        avgEntropy: 0,
        maxEntropy: 0,
        avgPressure: 0,
        maxPressure: 0,
      },
      repos: repos.rows,
      recentAlerts: recentAlerts.rows,
      recentActivity: recentActivity.rows,
      languageCoverage: languageCoverage.rows,
      languageWatchTrends,
      patterns,
      generatedAt: new Date().toISOString(),
    };
  });

  app.get("/overview/events", async (request, reply) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "*";

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": origin,
      vary: "Origin",
    });

    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

    const listener = (payload: Record<string, unknown>) => {
      reply.raw.write(`event: overview.refresh\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    }, 15000);

    app.memoryEvents.on("fleet", listener);

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      app.memoryEvents.off("fleet", listener);
      reply.raw.end();
    });
  });
}
