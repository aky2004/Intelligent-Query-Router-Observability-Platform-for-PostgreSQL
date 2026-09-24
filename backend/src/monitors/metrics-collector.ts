import { appConfig } from "../config/app";
import { getCache, redisKeys } from "../config/redis";
import type {
  MetricsSnapshot,
  QueryMetricInput,
  SlowQueryRecord,
  TimeSeriesPoint,
} from "../types/metrics";
import { average, nowIso, percentile, safeJsonParse } from "../utils/helpers";

const MAX_SERIES_POINTS = 2_000;
const MAX_SLOW_QUERIES = 200;

interface StoredMetric extends QueryMetricInput {
  timestamp: number;
}

export const recordQueryMetrics = async (input: QueryMetricInput): Promise<void> => {
  const cache = getCache();
  const entry: StoredMetric = { ...input, timestamp: Date.now() };

  await cache.lpush(redisKeys.queryHistory, JSON.stringify(entry));
  await cache.ltrim(redisKeys.queryHistory, 0, MAX_SERIES_POINTS - 1);
  await cache.expire(redisKeys.queryHistory, 86400); // 24 hours

  await cache.lpush(
    redisKeys.timeSeries("duration"),
    JSON.stringify({ timestamp: entry.timestamp, value: input.durationMs } satisfies TimeSeriesPoint),
  );
  await cache.ltrim(redisKeys.timeSeries("duration"), 0, MAX_SERIES_POINTS - 1);
  await cache.expire(redisKeys.timeSeries("duration"), 86400);

  if (input.error) {
    await cache.lpush(
      redisKeys.timeSeries("errors"),
      JSON.stringify({ timestamp: entry.timestamp, value: 1 } satisfies TimeSeriesPoint),
    );
    await cache.ltrim(redisKeys.timeSeries("errors"), 0, MAX_SERIES_POINTS - 1);
    await cache.expire(redisKeys.timeSeries("errors"), 86400);
  }

  if (input.durationMs > appConfig.thresholds.slowQueryMs) {
    const record: SlowQueryRecord = {
      sql: input.sql,
      durationMs: input.durationMs,
      nodeId: input.nodeId,
      occurredAt: nowIso(),
    };
    await cache.lpush(redisKeys.slowQueries, JSON.stringify(record));
    await cache.ltrim(redisKeys.slowQueries, 0, MAX_SLOW_QUERIES - 1);
    await cache.expire(redisKeys.slowQueries, 86400 * 7); // 7 days
  }
};

const readMetrics = async (windowMs: number): Promise<StoredMetric[]> => {
  const cache = getCache();
  const raw = await cache.lrange(redisKeys.queryHistory, 0, MAX_SERIES_POINTS - 1);
  const cutoff = Date.now() - windowMs;
  return raw
    .map((entry) => safeJsonParse<StoredMetric | null>(entry, null))
    .filter((entry): entry is StoredMetric => !!entry && entry.timestamp >= cutoff);
};

export const getMetrics = async (windowMs = 300_000): Promise<MetricsSnapshot> => {
  const metrics = await readMetrics(windowMs);
  const durations = metrics.map((m) => m.durationMs);
  const errors = metrics.filter((m) => m.error).length;
  const primary = metrics.filter((m) => m.target === "primary").length;
  const total = metrics.length;

  return {
    windowMs,
    queriesPerMinute: Math.round((metrics.length / (windowMs / 60_000)) * 100) / 100,
    avgDurationMs: average(durations),
    p95DurationMs: Math.round(percentile(durations, 95) * 100) / 100,
    errorRate: total > 0 ? Math.round((errors / total) * 1000) / 1000 : 0,
    primaryShare: total > 0 ? Math.round((primary / total) * 1000) / 1000 : 0,
    replicaShare: total > 0 ? Math.round(((total - primary) / total) * 1000) / 1000 : 0,
    slowQueryCount: durations.filter((d) => d > appConfig.thresholds.slowQueryMs).length,
    collectedAt: nowIso(),
  };
};

export const getTimeSeries = async (
  metric: "duration" | "throughput" | "errors",
  windowMs = 300_000,
): Promise<TimeSeriesPoint[]> => {
  if (metric === "throughput") {
    const metrics = await readMetrics(windowMs);
    const buckets = new Map<number, number>();
    for (const m of metrics) {
      const bucket = Math.floor(m.timestamp / 10_000) * 10_000;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    return [...buckets.entries()]
      .map(([timestamp, value]) => ({ timestamp, value }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  const cache = getCache();
  const raw = await cache.lrange(redisKeys.timeSeries(metric), 0, MAX_SERIES_POINTS - 1);
  const cutoff = Date.now() - windowMs;
  return raw
    .map((entry) => safeJsonParse<TimeSeriesPoint | null>(entry, null))
    .filter((p): p is TimeSeriesPoint => !!p && p.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
};

export const getSlowQueries = async (limit = 25): Promise<SlowQueryRecord[]> => {
  const cache = getCache();
  const raw = await cache.lrange(redisKeys.slowQueries, 0, limit - 1);
  return raw
    .map((entry) => safeJsonParse<SlowQueryRecord | null>(entry, null))
    .filter((r): r is SlowQueryRecord => !!r);
};
