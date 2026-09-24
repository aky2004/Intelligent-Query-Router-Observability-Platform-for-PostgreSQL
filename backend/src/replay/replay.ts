import { existsSync, readFileSync } from "fs";
import path from "path";
import { appConfig } from "../config/app";
import { executeQuery } from "../router/query-router";
import { NotFoundError } from "../utils/errors";
import { average, nowIso, safeJsonParse, sleep, uuid } from "../utils/helpers";
import { logger } from "../utils/logger";
import type { CapturedQuery } from "./capture";
import { bus } from "../events";

export type ReplaySpeed = 0.5 | 1 | 2 | 10;

export interface ReplayComparison {
  sql: string;
  originalDurationMs: number;
  replayDurationMs: number;
  originalRowCount: number;
  replayRowCount: number;
  rowCountMatches: boolean;
  slowerBy: number;
}

export interface ReplayStats {
  runId: string;
  file: string;
  speed: ReplaySpeed;
  status: "running" | "paused" | "completed" | "failed";
  currentQuery?: { sql: string; startTime: string };
  total: number;
  executed: number;
  failed: number;
  avgOriginalMs: number;
  avgReplayMs: number;
  mismatches: number;
  startedAt: string;
  finishedAt: string | null;
  comparisons: ReplayComparison[];
  error?: string;
}

const runs = new Map<string, ReplayStats>();
const paused = new Set<string>();
export const pauseReplay = (runId: string): ReplayStats => { const r = getRun(runId); if (r.status === "running") { paused.add(runId); r.status = "paused"; } return r; };
export const resumeReplay = (runId: string): ReplayStats => { const r = getRun(runId); if (paused.delete(runId)) r.status = "running"; return r; };
const getRun = (runId: string): ReplayStats => { const r = runs.get(runId); if (!r) throw new NotFoundError(`Replay run not found: ${runId}`); return r; };

const loadCapture = (file: string, limit?: number): CapturedQuery[] => {
  const resolved = path.isAbsolute(file) ? file : path.resolve(appConfig.captureDir, file);
  if (!existsSync(resolved)) throw new NotFoundError(`Capture file not found: ${file}`);
  const lines = readFileSync(resolved, "utf8").split("\n").filter(Boolean);
  const parsed = lines
    .map((line) => safeJsonParse<CapturedQuery | null>(line, null))
    .filter((q): q is CapturedQuery => !!q);
  return limit ? parsed.slice(0, limit) : parsed;
};

export interface ReplayOptions {
  file: string;
  speed?: ReplaySpeed;
  compare?: boolean;
  limit?: number;
}

/** Starts a replay run in the background and returns its handle immediately. */
export const replayQueries = (options: ReplayOptions): ReplayStats => {
  const speed = options.speed ?? 1;
  const queries = loadCapture(options.file, options.limit);
  const runId = uuid();

  const stats: ReplayStats = {
    runId,
    file: options.file,
    speed,
    status: "running",
    total: queries.length,
    executed: 0,
    failed: 0,
    avgOriginalMs: average(queries.map((q) => q.durationMs)),
    avgReplayMs: 0,
    mismatches: 0,
    startedAt: nowIso(),
    finishedAt: null,
    comparisons: [],
  };
  runs.set(runId, stats);

  void (async () => {
    const replayDurations: number[] = [];
    let previousOffset = queries[0]?.offsetMs ?? 0;

    for (const query of queries) {
      while (paused.has(runId)) await sleep(250);
      const wait = Math.max(0, (query.offsetMs - previousOffset) / speed);
      previousOffset = query.offsetMs;
      if (wait > 0) await sleep(Math.min(wait, 30_000));

      stats.currentQuery = { sql: query.sql, startTime: nowIso() };
      bus.emitEvent("replay:progress", { replayId: runId, current: stats.executed + stats.failed, total: stats.total, currentQuery: stats.currentQuery });
      try {
        const { result } = await executeQuery(query.sql, [], { sessionId: `replay-${runId}` });
        stats.executed += 1;
        replayDurations.push(result.durationMs);
        if (options.compare) {
          const comparison = compareResults(query, result.durationMs, result.rowCount);
          stats.comparisons.push(comparison);
          if (!comparison.rowCountMatches) stats.mismatches += 1;
        }
      } catch (error) {
        stats.failed += 1;
        logger.warn("Replay query failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      stats.avgReplayMs = average(replayDurations);
    }

    stats.status = "completed";
    stats.finishedAt = nowIso();
    delete stats.currentQuery;
    bus.emitEvent("replay:complete", { replayId: runId, summary: { totalQueries: stats.total, avgLatency: stats.avgReplayMs, errors: stats.failed, mismatches: stats.mismatches } });
    logger.info("Replay finished", { runId, executed: stats.executed, failed: stats.failed });
  })().catch((error) => {
    stats.status = "failed";
    stats.error = error instanceof Error ? error.message : String(error);
    stats.finishedAt = nowIso();
  });

  return stats;
};

export const compareResults = (
  original: CapturedQuery,
  replayDurationMs: number,
  replayRowCount: number,
): ReplayComparison => ({
  sql: original.sql,
  originalDurationMs: original.durationMs,
  replayDurationMs,
  originalRowCount: original.rowCount,
  replayRowCount,
  rowCountMatches: original.rowCount < 0 || original.rowCount === replayRowCount, // -1 = unknown
  slowerBy: Math.round((replayDurationMs - original.durationMs) * 100) / 100,
});

export const getReplayStats = (runId?: string): ReplayStats | ReplayStats[] => {
  if (runId) {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError(`Replay run not found: ${runId}`);
    return run;
  }
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};
