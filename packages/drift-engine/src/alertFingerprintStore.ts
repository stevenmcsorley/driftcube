import { createHash } from "node:crypto";
import { createClient } from "redis";
import type { AlertRaised } from "@driftcube/shared";
import { createLogger } from "@driftcube/shared";

const logger = createLogger("drift-fingerprint-store");

const FINGERPRINT_WINDOW_MS = 15 * 60 * 1000;
const FINGERPRINT_WINDOW_SECONDS = Math.floor(FINGERPRINT_WINDOW_MS / 1000);
const CONNECT_ATTEMPTS = 12;
const CONNECT_RETRY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);

  return `{${entries.join(",")}}`;
}

export function buildAlertFingerprint(alert: AlertRaised): string {
  const entropyIndex = Number(alert.evidence.metrics?.code_entropy_index ?? 0);
  const previousEntropyIndex = Number(alert.evidence.metrics?.previous_entropy_index ?? 0);
  const pressureIndex = Number(alert.evidence.metrics?.pressure_index ?? 0);
  const pressureDelta24h = Number(alert.evidence.metrics?.pressure_delta_24h ?? 0);
  const evidence = {
    filePath: alert.evidence.filePath ?? null,
    symbolId: alert.evidence.symbolId ?? null,
    module: alert.evidence.module ?? null,
    graphEdgesAdded: [...(alert.evidence.graphEdgesAdded ?? [])].sort(),
    graphEdgesRemoved: [...(alert.evidence.graphEdgesRemoved ?? [])].sort(),
    neighbours: [...(alert.evidence.neighbours ?? [])]
      .map((item) => ({ id: item.id, score: Number(item.score.toFixed(3)) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    metrics: alert.type === "ENTROPY_DRIFT"
      ? {
        entropyIndex: Number(entropyIndex.toFixed(2)),
        previousEntropyIndex: Number(previousEntropyIndex.toFixed(2)),
      }
      : alert.type === "ARCH_PRESSURE"
        ? {
          pressureIndex: Number(pressureIndex.toFixed(2)),
          pressureDelta24h: Number(pressureDelta24h.toFixed(2)),
        }
        : null,
  };

  return createHash("sha256")
    .update(stableStringify({
      repoId: alert.repoId,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      evidence,
    }))
    .digest("hex");
}

export function supportsFingerprintDedupe(alert: AlertRaised): boolean {
  return ["ARCH_VIOLATION", "ARCH_EMBED_DRIFT", "ARCH_PRESSURE", "ENTROPY_DRIFT"].includes(alert.type);
}

interface AlertFingerprintStore {
  shouldSuppress(alert: AlertRaised): Promise<boolean>;
  close(): Promise<void>;
}

class MemoryAlertFingerprintStore implements AlertFingerprintStore {
  private readonly recent = new Map<string, number>();

  async shouldSuppress(alert: AlertRaised): Promise<boolean> {
    if (!supportsFingerprintDedupe(alert)) {
      return false;
    }

    const now = Date.now();
    for (const [fingerprint, ts] of this.recent.entries()) {
      if (now - ts > FINGERPRINT_WINDOW_MS) {
        this.recent.delete(fingerprint);
      }
    }

    const fingerprint = buildAlertFingerprint(alert);
    const previous = this.recent.get(fingerprint);
    if (previous && (now - previous) < FINGERPRINT_WINDOW_MS) {
      return true;
    }

    this.recent.set(fingerprint, now);
    return false;
  }

  async close(): Promise<void> {}
}

class RedisAlertFingerprintStore implements AlertFingerprintStore {
  constructor(private readonly redis: ReturnType<typeof createClient>) {}

  async shouldSuppress(alert: AlertRaised): Promise<boolean> {
    if (!supportsFingerprintDedupe(alert)) {
      return false;
    }

    const fingerprint = buildAlertFingerprint(alert);
    const key = `alert:fingerprint:${fingerprint}`;
    const result = await this.redis.set(key, new Date().toISOString(), {
      NX: true,
      EX: FINGERPRINT_WINDOW_SECONDS,
    });

    return result === null;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export async function createAlertFingerprintStore(): Promise<AlertFingerprintStore> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.info("redis dedupe unavailable, using memory store");
    return new MemoryAlertFingerprintStore();
  }

  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const redis = createClient({ url: redisUrl });

    try {
      redis.on("error", (error) => {
        logger.warn("redis client error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await redis.connect();
      logger.info("redis dedupe ready", {
        redisUrl,
        attempt,
      });
      return new RedisAlertFingerprintStore(redis);
    } catch (error) {
      logger.warn("redis connect attempt failed", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await redis.disconnect();
      } catch {}
      if (attempt < CONNECT_ATTEMPTS) {
        await sleep(CONNECT_RETRY_MS);
      }
    }
  }

  logger.warn("redis dedupe unavailable, falling back to memory store", { redisUrl });
  return new MemoryAlertFingerprintStore();
}
