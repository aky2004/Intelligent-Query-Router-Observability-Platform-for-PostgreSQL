import { appConfig } from "../config/app";
import { getCache, redisKeys } from "../config/redis";
import { bus } from "../events";
import type { AnomalyAlert, AnomalyKind, QueryPattern } from "../types/ai";
import { cosineSimilarity, nowIso, safeJsonParse, sha1, uuid } from "../utils/helpers";
import { logger } from "../utils/logger";
import { embed } from "./huggingface-client";

const SIMILARITY_THRESHOLD = 0.82;
const N_PLUS_ONE_REPEATS = 8;
const N_PLUS_ONE_WINDOW_MS = 2_000;
const SPIKE_MULTIPLIER = 3;

const recent: Array<{ normalized: string; at: number; durationMs: number }> = [];

export const embedQuery = async (normalized: string): Promise<number[]> => (await embed(normalized)).vector;

export const getPatternHistory = async (): Promise<QueryPattern[]> => {
  const cache = getCache();
  const raw = await cache.lrange(redisKeys.patternHistory, 0, appConfig.thresholds.anomalyWindow - 1);
  return raw.map((entry) => safeJsonParse<QueryPattern | null>(entry, null)).filter((p): p is QueryPattern => !!p);
};

const rememberPattern = async (pattern: QueryPattern): Promise<void> => {
  const cache = getCache();
  await cache.lpush(redisKeys.patternHistory, JSON.stringify(pattern));
  await cache.ltrim(redisKeys.patternHistory, 0, appConfig.thresholds.anomalyWindow - 1);
  await cache.hset(redisKeys.patternHash, sha1(pattern.normalized), String(pattern.count));
};

export const detectAnomaly = async (
  sql: string,
  normalized: string,
  durationMs: number,
): Promise<AnomalyAlert | null> => {
  const now = Date.now();
  recent.push({ normalized, at: now, durationMs });
  while (recent.length && now - recent[0].at > 60_000) recent.shift();

  const history = await getPatternHistory();
  const { vector } = await embed(normalized);

  const alerts: Array<{ kind: AnomalyKind; score: number; message: string }> = [];

  // N+1: the same normalized shape repeated many times in a tight window.
  const burst = recent.filter((r) => r.normalized === normalized && now - r.at <= N_PLUS_ONE_WINDOW_MS);
  if (burst.length >= N_PLUS_ONE_REPEATS) {
    alerts.push({
      kind: "n_plus_one",
      score: Math.min(1, burst.length / (N_PLUS_ONE_REPEATS * 2)),
      message: `Possible N+1: identical query shape ran ${burst.length} times in ${N_PLUS_ONE_WINDOW_MS} ms`,
    });
  }

  // Volume spike: last 10s rate far above the trailing minute average.
  const lastTenSeconds = recent.filter((r) => now - r.at <= 10_000).length;
  const perTenSecondAverage = recent.length / 6;
  if (perTenSecondAverage > 2 && lastTenSeconds > perTenSecondAverage * SPIKE_MULTIPLIER) {
    alerts.push({
      kind: "volume_spike",
      score: Math.min(1, lastTenSeconds / (perTenSecondAverage * SPIKE_MULTIPLIER * 2)),
      message: `Query volume spike: ${lastTenSeconds} queries in 10s vs ${perTenSecondAverage.toFixed(1)} expected`,
    });
  }

  // New query shape: no historical embedding is semantically close.
  const closest = history.reduce(
    (best, pattern) => {
      const similarity = cosineSimilarity(vector, pattern.embedding);
      return similarity > best.similarity ? { similarity, pattern } : best;
    },
    { similarity: 0, pattern: null as QueryPattern | null },
  );

  if (history.length >= 10 && closest.similarity < SIMILARITY_THRESHOLD) {
    alerts.push({
      kind: "new_query_shape",
      score: 1 - closest.similarity,
      message: `Unseen query shape (max similarity ${closest.similarity.toFixed(2)} to ${history.length} known patterns)`,
    });
  }

  // Latency spike relative to this shape's own history.
  const sameShape = recent.filter((r) => r.normalized === normalized);
  if (sameShape.length > 5) {
    const avg = sameShape.reduce((sum, r) => sum + r.durationMs, 0) / sameShape.length;
    if (avg > 0 && durationMs > avg * 4 && durationMs > appConfig.thresholds.slowQueryMs) {
      alerts.push({
        kind: "latency_spike",
        score: Math.min(1, durationMs / (avg * 10)),
        message: `Latency spike: ${durationMs.toFixed(0)} ms vs ${avg.toFixed(0)} ms baseline`,
      });
    }
  }

  await rememberPattern({
    normalized,
    embedding: vector,
    count: (closest.pattern?.normalized === normalized ? closest.pattern.count : 0) + 1,
    firstSeenAt: closest.pattern?.firstSeenAt ?? nowIso(),
    lastSeenAt: nowIso(),
  });

  if (!alerts.length) return null;

  const worst = alerts.sort((a, b) => b.score - a.score)[0];
  const alert: AnomalyAlert = {
    id: uuid(),
    kind: worst.kind,
    score: Math.round(worst.score * 100) / 100,
    message: worst.message,
    sql,
    normalized,
    detectedAt: nowIso(),
  };

  logger.warn("Anomaly detected", { kind: alert.kind, score: alert.score });
  bus.emitEvent("anomaly:detected", alert);
  return alert;
};
