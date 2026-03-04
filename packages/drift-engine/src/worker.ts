import {
  Subjects,
  publishJson,
  subscribeJson,
  type AlertRaised,
  type EmbeddingsUpserted,
  type GraphUpdated,
  type MetricsWritten,
  type RefactorRefreshRequested,
} from "@driftcube/shared";
import { createLogger } from "@driftcube/shared";
import type { NatsConnection } from "nats";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type neo4j from "neo4j-driver";
import type { Pool } from "pg";
import type { createAlertFingerprintStore } from "./alertFingerprintStore.js";
import { supportsFingerprintDedupe } from "./alertFingerprintStore.js";
import { reconcileIncidents, trackIncidentForAlert } from "./incidentTracker.js";
import { detectArchitecturePressure } from "./rules/archPressure.js";
import { detectArchitectureViolations } from "./rules/archViolations.js";
import { detectArchitectureEmbeddingDrift } from "./rules/archEmbeddingDrift.js";
import { detectComplexityCreep } from "./rules/complexityCreep.js";
import { detectSemanticDuplication } from "./rules/duplication.js";
import { detectEntropyDrift } from "./rules/entropyDrift.js";
import { detectIntentDrift } from "./rules/intentDrift.js";
import { detectVolatilityZones } from "./rules/volatilityZones.js";
import { generateRefactorSuggestions, replaceRefactorSuggestions } from "../../api/src/lib/refactors.js";

const logger = createLogger("drift-engine");
const refactorRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

async function storeAlert(pool: Pool, alert: AlertRaised): Promise<void> {
  await pool.query(
    `
      INSERT INTO alerts (repo_id, sha, at, severity, type, title, evidence, recommendation)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT (repo_id, sha, at, type, title)
      DO NOTHING
    `,
    [
      alert.repoId,
      alert.commitSha,
      alert.at,
      alert.severity,
      alert.type,
      alert.title,
      JSON.stringify(alert.evidence),
      alert.recommendation ?? null,
    ],
  );
}

async function emitAlerts(
  nc: NatsConnection,
  pool: Pool,
  alerts: AlertRaised[],
  fingerprintStore: Awaited<ReturnType<typeof createAlertFingerprintStore>>,
): Promise<void> {
  for (const alert of alerts) {
    if (supportsFingerprintDedupe(alert) && await fingerprintStore.shouldSuppress(alert)) {
      logger.info("alert suppressed", {
        type: alert.type,
        title: alert.title,
      });
      continue;
    }

    await storeAlert(pool, alert);
    await trackIncidentForAlert(pool, alert);
    await publishJson(nc, Subjects.AlertRaised, alert);
    logger.warn("alert raised", {
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
    });
  }
}

function scheduleRefactorRefresh(nc: NatsConnection, pool: Pool, repoId: string, reason: string): void {
  const current = refactorRefreshes.get(repoId);
  if (current) {
    clearTimeout(current);
  }

  const timeout = setTimeout(() => {
    void (async () => {
      const suggestions = await generateRefactorSuggestions(pool, repoId);
      await replaceRefactorSuggestions(pool, repoId, suggestions);
      await publishJson(nc, Subjects.RefactorSuggestionsUpdated, {
        schemaVersion: 1,
        repoId,
        total: suggestions.length,
        topSuggestionId: suggestions[0]?.id,
        refreshedAt: new Date().toISOString(),
      });
      logger.info("refactor suggestions refreshed", {
        repoId,
        total: suggestions.length,
        reason,
      });
    })()
      .catch((error) => {
        logger.error("refactor suggestion refresh failed", {
          repoId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        refactorRefreshes.delete(repoId);
      });
  }, 1600);

  refactorRefreshes.set(repoId, timeout);
}

export function startDriftWorker(
  nc: NatsConnection,
  pool: Pool,
  qdrant: QdrantClient,
  driver: neo4j.Driver,
  fingerprintStore: Awaited<ReturnType<typeof createAlertFingerprintStore>>,
): void {
  subscribeJson<EmbeddingsUpserted>(nc, Subjects.EmbeddingsUpserted, async (event) => {
    const alerts = [
      ...(await detectSemanticDuplication(qdrant, event)),
      ...(await detectIntentDrift(qdrant, event)),
    ];
    await emitAlerts(nc, pool, alerts, fingerprintStore);
    scheduleRefactorRefresh(nc, pool, event.repoId, "embedding-signals");
  });

  subscribeJson<MetricsWritten>(nc, Subjects.MetricsWritten, async (event) => {
    const alerts = [
      ...detectComplexityCreep(event),
      ...(await detectArchitecturePressure(pool, event)),
      ...(await detectEntropyDrift(pool, event)),
      ...(await detectVolatilityZones(pool, event)),
    ];
    await emitAlerts(nc, pool, alerts, fingerprintStore);
    await reconcileIncidents(pool, event);
    scheduleRefactorRefresh(nc, pool, event.repoId, "metric-frame");
  });

  subscribeJson<GraphUpdated>(nc, Subjects.GraphUpdated, async (event) => {
    const [violations, embeddingDrift] = await Promise.all([
      detectArchitectureViolations(driver, event),
      detectArchitectureEmbeddingDrift(pool, qdrant, event),
    ]);
    const alerts = [...violations, ...embeddingDrift];
    await emitAlerts(nc, pool, alerts, fingerprintStore);
    scheduleRefactorRefresh(nc, pool, event.repoId, "graph-drift");
  });

  subscribeJson<RefactorRefreshRequested>(nc, Subjects.RefactorRefreshRequested, async (event) => {
    scheduleRefactorRefresh(nc, pool, event.repoId, event.reason);
  });
}
