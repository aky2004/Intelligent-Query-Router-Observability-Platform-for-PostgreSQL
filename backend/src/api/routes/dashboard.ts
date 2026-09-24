/**
 * Endpoints consumed by the pg-router-ai dashboard (see README "Dashboard API").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { Router } from "express";
import { getCaptureStatus } from "../../replay/capture";
import multer from "multer";
import { z } from "zod";
import { aiEnabled } from "../../config/ai";
import { appConfig } from "../../config/app";
import { runtimeSettings } from "../../config/runtime";
import { convertToSQL } from "../../ai/nl-to-sql";
import { analyzeQuery } from "../../ai/optimizer";
import { acknowledgeAlert, alertPatterns, listAlerts } from "../../monitors/alert-store";
import { getLatestHealth, runHealthCheck } from "../../monitors/health-checker";
import { getMetrics, getSlowQueries, getTimeSeries } from "../../monitors/metrics-collector";
import { getReplicationLag } from "../../monitors/lag-monitor";
import { addNode, checkHealth, getNodes, getPoolStats, removeNode } from "../../router/pool-manager";
import { getAllBreakers } from "../../router/circuit-breaker";
import { executeQuery, getQueryHistory, getQueryStats } from "../../router/query-router";
import { getReplayStats, pauseReplay, replayQueries, resumeReplay, type ReplayStats } from "../../replay/replay";
import { NotFoundError, ValidationError, isAppError } from "../../utils/errors";
import { MAX_SQL_LENGTH, parseWith } from "../../utils/validators";
import { nowIso, uuid } from "../../utils/helpers";
import { evaluateQuerySafety } from "../../ai/deepseek-bedrock";
import { checkVectorSimilarity } from "../../ai/anomaly";
import { parseQuery } from "../../router/parser";
import { getCache, redisKeys } from "../../config/redis";
import { fail, ok } from "../response";

export const dashboardRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const uploads = new Map<string, { file: string; fileName: string; queryCount: number }>();

const COLORS = ["#1A3C2B", "#9EFFBF", "#F4D35E", "#FF8C69"];
const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const wrap = (fn: (req: any, res: any) => Promise<unknown> | unknown) => async (req: any, res: any, next: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const startedAt = Date.now();
  try { const data = await fn(req, res); if (!res.headersSent) ok(res, data, startedAt); } catch (e) { next(e); }
};

/* ---------- pool pressure ---------- */
let poolInFlight: Promise<any> | null = null;
dashboardRouter.get("/pool/pressure", wrap(async () => {
  const cache = getCache();
  try {
    const cached = await cache.get("pool:pressure:cached");
    if (cached) return JSON.parse(cached);
  } catch { /* proceed */ }

  if (poolInFlight) return poolInFlight;

  poolInFlight = (async () => {
    try {
      const pools = getPoolStats();
      const breakers = getAllBreakers();
      const health = getLatestHealth();
      const data = {
        nodes: pools.map((p) => {
          const h = health.find((x) => x.nodeId === p.nodeId);
          const b = breakers.find((x) => x.nodeId === p.nodeId);
          return {
            nodeId: p.nodeId,
            role: health.find((x) => x.nodeId === p.nodeId)?.role ?? "primary",
            connections: { total: p.total, idle: p.idle, waiting: p.waiting, active: p.active, pressure: p.pressure },
            circuitBreaker: { state: b?.state ?? "CLOSED", failures: b?.failures ?? 0 },
            healthy: h?.healthy ?? true,
            responseTimeMs: h?.responseTimeMs ?? 0,
          };
        }),
      };
      void cache.set("pool:pressure:cached", JSON.stringify(data), 1);
      return data;
    } finally {
      poolInFlight = null;
    }
  })();

  return poolInFlight;
}));

/* ---------- nodes ---------- */
const nodeView = async () => {
  const health = getLatestHealth().length ? getLatestHealth() : await runHealthCheck();
  const pools = getPoolStats();
  const lag = await getReplicationLag();
  const history = getQueryHistory(500);
  return getNodes().map((n) => {
    const h = health.find((x) => x.nodeId === n.id);
    const p = pools.find((x) => x.nodeId === n.id);
    const l = lag.find((x) => x.nodeId === n.id);
    const recent = history.filter((q) => q.decision.nodeId === n.id && Date.now() - new Date(q.executedAt).getTime() < 60_000).length;
    const lagMs = n.role === "replica" ? (l?.lagMs ?? h?.replicationLagMs ?? 0) : null;
    const status = !h?.healthy ? "unhealthy" : lagMs != null && lagMs > runtimeSettings.thresholds.replicaLagMs ? "degraded" : "healthy";
    let host = n.id;
    try { const u = new URL(n.connectionString); host = `${u.hostname}:${u.port || 5432}`; } catch { /* keep id */ }
    return {
      id: n.id, name: n.id, role: n.role, status, host, connectionString: n.connectionString,
      poolUsage: { current: h?.activeConnections ?? (p ? p.total - p.idle : 0), max: n.maxConnections },
      throughput: Math.round((recent / 60) * 100) / 100,
      avgLatency: h?.responseTimeMs ?? 0,
      replicaLag: lagMs,
      lastChecked: h?.lastCheckedAt ?? nowIso(),
    };
  });
};
dashboardRouter.get("/nodes", wrap(async () => ({ nodes: await nodeView() })));


/**
 * POST /api/nodes — Connect a new database node.
 *
 * Accepts a full PostgreSQL connection URL so users can onboard their own
 * database (SaaS Method B). Role may be "primary" (only if none exists yet)
 * or "replica".
 *
 * Body:
 *   connectionString  string   Full postgresql:// URL (required)
 *   role              "primary" | "replica"   default: "primary" if no primary exists, else "replica"
 *   name              string?  Auto-derived from URL hostname if omitted
 */
const nodeBody = z.object({
  connectionString: z
    .string()
    .min(10)
    .refine((s) => /^postgresql:\/\/.+/.test(s) || /^postgres:\/\/.+/.test(s), {
      message: "Must be a valid postgresql:// or postgres:// connection string",
    }),
  role: z.enum(["primary", "replica"]).optional(),
  name: z
    .string()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined))
    .refine((val) => val === undefined || /^[a-z0-9-]{2,32}$/.test(val), {
      message: "Lowercase letters, numbers and dashes (2–32 chars)",
    }),
  // Legacy host:port fields — still accepted for backwards compatibility
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

dashboardRouter.post("/nodes", wrap(async (req) => {
  const b = parseWith(nodeBody, req.body);

  // Determine role: if no primary exists yet, default to "primary"
  const hasPrimary = getNodes().some((n) => n.role === "primary");
  const role: "primary" | "replica" = b.role ?? (hasPrimary ? "replica" : "primary");

  // Auto-generate a stable node name from the connection string if not provided
  let name = b.name;
  if (!name) {
    try {
      const url = new URL(b.connectionString);
      const hostPart = url.hostname.split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20);
      name = role === "primary" ? "primary" : `replica-${getNodes().filter((n) => n.role === "replica").length + 1}`;
      // Use hostname-based name only if it's safe
      if (/^[a-z0-9-]{2,32}$/.test(hostPart) && hostPart.length >= 2) {
        name = role === "primary" ? hostPart : `${hostPart}-replica`;
      }
    } catch {
      name = role === "primary" ? "primary" : `replica-${Date.now()}`;
    }
  }

  // Ensure no duplicate IDs
  if (getNodes().some((n) => n.id === name)) {
    // Append a numeric suffix to avoid collision
    name = `${name}-${getNodes().filter((n) => n.id.startsWith(name!)).length + 1}`;
  }

  if (role === "primary" && hasPrimary) {
    throw new ValidationError("A primary node is already connected. Remove it first to replace it.");
  }

  addNode({ id: name, role, maxConnections: role === "primary" ? 20 : 10, connectionString: b.connectionString });
  const h = await checkHealth(name);
  const node = (await nodeView()).find((n) => n.id === name);
  return { node, status: h.healthy ? "connected" : "connection_failed", error: h.error };
}));

dashboardRouter.delete("/nodes/:id", wrap(async (req) => {
  if (!(await removeNode(req.params.id))) {
    throw new NotFoundError("Node not found or cannot be removed (simulated primary nodes cannot be deleted)");
  }
  return { removed: req.params.id };
}));

dashboardRouter.post("/nodes/:id/test", wrap(async (req) => {
  if (!getNodes().some((n) => n.id === req.params.id)) throw new NotFoundError("Node not found");
  const h = await checkHealth(req.params.id);
  return { status: h.healthy ? "success" : "failed", error: h.error, latencyMs: h.responseTimeMs };
}));



/* ---------- metrics ---------- */
let dashboardInFlight: Promise<any> | null = null;
dashboardRouter.get("/metrics/dashboard", wrap(async () => {
  const cache = getCache();
  const cached = await cache.get(redisKeys.dashboardMetrics);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* ignore parsing errors */ }
  }

  if (dashboardInFlight) return dashboardInFlight;

  dashboardInFlight = (async () => {
    try {
      const [m, slow, series, nodes] = await Promise.all([getMetrics(60_000), getSlowQueries(10), getTimeSeries("throughput", 300_000), nodeView()]);
      const stats = getQueryStats();
      const active = nodes.reduce((a, n) => a + n.poolUsage.current, 0);
      const total = nodes.reduce((a, n) => a + n.poolUsage.max, 0);
      const history = getQueryHistory(500);
      const counts = nodes.map((n) => history.filter((q) => q.decision.nodeId === n.id).length);
      const sum = counts.reduce((a, b) => a + b, 0) || 1;
      const data = {
        connections: { total, active, idle: Math.max(0, total - active) },
        queriesPerSecond: Math.round((m.queriesPerMinute / 60) * 100) / 100,
        avgLatency: `${m.avgDurationMs.toFixed(1)}ms`,
        errorRate: `${(m.errorRate * 100).toFixed(2)}%`,
        routingDistribution: nodes.map((n, i) => ({ name: n.role === "primary" ? "Primary" : n.id, value: Math.round((counts[i]! / sum) * 100), color: COLORS[i % COLORS.length] })),
        queryVolume: series.map((p) => ({ time: new Date(p.timestamp).toISOString().slice(11, 16), queries: p.value })),
        slowQueries: slow.map((s) => ({ query: s.sql, node: s.nodeId, duration: `${s.durationMs.toFixed(0)}ms`, timestamp: s.occurredAt })),
        activeAlerts: listAlerts({ limit: 5 }).filter((a) => !a.acknowledged).map((a) => ({ id: a.id, severity: a.severity, message: a.message, time: ago(a.details.detectedAt) })),
        totals: stats,
      };
      void cache.set(redisKeys.dashboardMetrics, JSON.stringify(data), 2);
      return data;
    } finally {
      dashboardInFlight = null;
    }
  })();

  return dashboardInFlight;
}));

const timeseriesInFlight = new Map<string, Promise<any>>();
dashboardRouter.get("/metrics/timeseries", wrap(async (req) => {
  const start = req.query.start ? new Date(String(req.query.start)).getTime() : Date.now() - 300_000;
  const end = req.query.end ? new Date(String(req.query.end)).getTime() : Date.now();
  const roundedEnd = Math.floor(end / 2000) * 2000; // 2s bucket key
  const cacheKey = `metrics:timeseries:${Math.floor(start / 2000)}:${roundedEnd}`;
  const cache = getCache();

  try {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch { /* proceed */ }

  const existing = timeseriesInFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const windowMs = Math.max(10_000, Math.min(Date.now() - start, 86_400_000));
      const inRange = <T extends { timestamp: number }>(pts: T[]) => pts.filter((p) => p.timestamp >= start && p.timestamp <= end);
      const [throughput, latency, errors, lag] = await Promise.all([getTimeSeries("throughput", windowMs), getTimeSeries("duration", windowMs), getTimeSeries("errors", windowMs), getReplicationLag()]);
      const maxLag = lag.reduce((a, l) => Math.max(a, l.lagMs ?? 0), 0);
      const iso = (pts: { timestamp: number; value: number }[]) => inRange(pts).map((p) => ({ timestamp: new Date(p.timestamp).toISOString(), value: p.value }));
      const data = {
        throughput: iso(throughput).map((p) => ({ ...p, value: p.value / 10 })), // 10s buckets → per second
        latency: iso(latency),
        replicaLag: [{ timestamp: nowIso(), value: maxLag }],
        errorRate: iso(errors),
      };
      void cache.set(cacheKey, JSON.stringify(data), 2);
      return data;
    } finally {
      timeseriesInFlight.delete(cacheKey);
    }
  })();

  timeseriesInFlight.set(cacheKey, promise);
  return promise;
}));

/* ---------- queries ---------- */
const execBody = z.object({
  sql: z.string().min(1).max(MAX_SQL_LENGTH),
  useExplain: z.boolean().optional(),
  targetNode: z.string().optional(),
  sessionId: z.string().optional(),
  checkSafety: z.boolean().optional(),
});
dashboardRouter.post("/query/execute", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const b = parseWith(execBody, req.body);
    const sessionId = b.sessionId ?? (req.headers["x-session-id"] as string | undefined) ?? "default";

    // DeepSeek Bedrock safety check with vector embedding evaluation
    let safetyInfo = undefined;
    if (b.checkSafety) {
      const parsedQuery = parseQuery(b.sql);
      const vectorContext = await checkVectorSimilarity(parsedQuery.normalized);
      safetyInfo = await evaluateQuerySafety(b.sql, vectorContext);
      if (!safetyInfo.isSafe && safetyInfo.riskLevel === "CRITICAL") {
        return fail(res, 400, "UNSAFE_QUERY_BLOCKED", `DeepSeek blocked dangerous query: ${safetyInfo.reasons.join(", ")}`, {
          safety: safetyInfo,
        });
      }
    }

    const sql = b.useExplain && !/^\s*explain/i.test(b.sql) ? `EXPLAIN (ANALYZE, FORMAT JSON) ${b.sql}` : b.sql;
    const { result, decision } = await executeQuery(sql, [], {
      forcePrimary: b.targetNode === "primary",
      sessionId,
    });
    const plan = b.useExplain ? (result.rows[0] as Record<string, unknown> | undefined)?.["QUERY PLAN"] : undefined;
    ok(res, {
      results: b.useExplain ? [] : result.rows,
      rowCount: result.rowCount,
      executionTime: `${result.durationMs.toFixed(2)}ms`,
      routedTo: result.nodeId,
      target: decision.target,
      routingReason: decision.reason,
      fromCache: Boolean(result.fromCache),
      sessionId,
      ...(safetyInfo ? { safety: safetyInfo } : {}),
      ...(plan ? { queryPlan: plan } : {}),
    }, startedAt);
  } catch (e) {
    // SQL errors are user errors, not server errors
    if (e instanceof Error && !isAppError(e)) return fail(res, 400, "QUERY_ERROR", e.message);
    next(e);
  }
});
dashboardRouter.get("/queries/history", wrap((req) => ({
  queries: getQueryHistory(Math.min(Number(req.query.limit ?? 50) || 50, 500)).map((q) => ({ id: q.id, sql: q.sql, executedAt: q.executedAt, duration: `${q.durationMs.toFixed(1)}ms`, status: q.error ? "error" : "success" })),
})));

/* ---------- AI ---------- */
dashboardRouter.post("/ai/safety", wrap(async (req) => {
  const b = parseWith(z.object({ sql: z.string().min(1).max(MAX_SQL_LENGTH) }), req.body);
  const parsed = parseQuery(b.sql);
  const vectorContext = await checkVectorSimilarity(parsed.normalized);
  const safety = await evaluateQuerySafety(b.sql, vectorContext);
  return { safety };
}));
dashboardRouter.post("/ai/analyze", wrap(async (req) => {
  const b = parseWith(z.object({ sql: z.string().min(1).max(MAX_SQL_LENGTH), executionTime: z.number().nonnegative().optional() }), req.body);
  const r = await analyzeQuery({ sql: b.sql, ...(b.executionTime !== undefined ? { executionTimeMs: b.executionTime } : {}) });
  const suggestions = [
    ...r.indexes.map((i) => ({ type: "INDEX_SUGGESTION", message: `${i.rationale}`, confidence: 0.8, estimatedImprovement: "40%", autoFixAvailable: true, sql: i.statement })),
    ...(r.rewrite ? [{ type: "REWRITE_PROPOSAL", message: r.summary, confidence: 0.7, estimatedImprovement: "25%", autoFixAvailable: true, sql: r.rewrite }] : []),
    ...r.warnings.map((w) => ({ type: "WARNING", message: w, confidence: 0.9 })),
  ];
  return { suggestions };
}));
dashboardRouter.post("/ai/convert", wrap(async (req) => {
  const b = parseWith(z.object({ naturalLanguage: z.string().min(3).max(2000), schema: z.string().max(50_000).optional() }), req.body);
  const r = await convertToSQL(b.naturalLanguage, b.schema);
  return { sql: r.sql, confidence: r.confidence, explanation: r.explanation };
}));

/* ---------- anomalies ---------- */
dashboardRouter.get("/anomalies", wrap((req) => {
  const alerts = listAlerts({ severity: String(req.query.severity ?? "all"), timeRange: String(req.query.timeRange ?? "24h"), limit: Number(req.query.limit ?? 50) || 50 });
  return { alerts, patterns: alertPatterns(alerts) };
}));
dashboardRouter.post("/anomalies/:id/acknowledge", wrap((req) => {
  const a = acknowledgeAlert(req.params.id, typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : undefined);
  if (!a) throw new NotFoundError("Alert not found");
  return { alert: a };
}));

/* ---------- replay ---------- */
dashboardRouter.get("/replay/live-capture", wrap(async (req) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 1000));
  const status = getCaptureStatus();
  let allQueries: Array<{ sql: string; durationMs: number; offsetMs: number; timestamp?: string }> = [];

  if (status.file && existsSync(status.file)) {
    try {
      const raw = readFileSync(status.file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      allQueries = lines.map((l) => {
        try {
          const parsed = JSON.parse(l);
          return {
            sql: parsed.sql ?? parsed.query,
            durationMs: Number(parsed.durationMs ?? parsed.duration ?? 5),
            offsetMs: Number(parsed.offsetMs ?? 0),
            timestamp: parsed.timestamp,
          };
        } catch {
          return null;
        }
      }).filter(Boolean) as Array<{ sql: string; durationMs: number; offsetMs: number; timestamp?: string }>;
    } catch { /* fallback */ }
  }

  // If capture file is empty, fallback to recent in-memory query history
  if (allQueries.length === 0) {
    const history = getQueryHistory(limit);
    allQueries = history.map((q) => ({
      sql: q.sql,
      durationMs: q.durationMs,
      offsetMs: 0,
      timestamp: q.executedAt,
    }));
  }

  // Slice the most recent `limit` queries
  const selected = allQueries.slice(-limit);
  const t0 = selected.length && selected[0]?.timestamp ? new Date(selected[0].timestamp).getTime() : 0;

  // Recalibrate offsets relative to the start of this selected window
  const queries = selected.map((q, idx) => ({
    ...q,
    offsetMs: q.timestamp && t0 ? Math.max(0, new Date(q.timestamp).getTime() - t0) : idx * 100,
  }));

  const uploadId = uuid();
  const dir = path.resolve(appConfig.captureDir, "uploads");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uploadId}.jsonl`);
  const normalized = queries.map((q) => JSON.stringify(q)).join("\n");
  writeFileSync(file, normalized);
  const fileName = `live-capture-latest-${queries.length}.jsonl`;
  uploads.set(uploadId, { file, fileName, queryCount: queries.length });

  return {
    uploadId,
    fileName,
    totalAvailable: allQueries.length,
    count: queries.length,
    queries,
    rawJsonl: normalized,
  };
}));

dashboardRouter.get("/replay/download", (req, res, next) => {
  try {
    const status = getCaptureStatus();
    if (status.file && existsSync(status.file)) {
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(status.file)}"`);
      res.setHeader("Content-Type", "application/x-ndjson");
      return res.sendFile(path.resolve(status.file));
    }
    const history = getQueryHistory(100);
    const content = history.map((q) => JSON.stringify({
      timestamp: q.executedAt,
      sql: q.sql,
      durationMs: q.durationMs,
      nodeId: q.decision.nodeId,
    })).join("\n");
    res.setHeader("Content-Disposition", 'attachment; filename="live-queries.jsonl"');
    res.setHeader("Content-Type", "application/x-ndjson");
    res.send(content);
  } catch (e) {
    next(e);
  }
});

dashboardRouter.post("/replay/upload", upload.single("file"), wrap((req) => {
  if (!req.file) throw new ValidationError("No file uploaded (field name: file)");
  const text = req.file.buffer.toString("utf8");
  const rows = text.split("\n").filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Record<string, unknown>[];
  if (!rows.length) throw new ValidationError("Expected JSON lines with sql, durationMs and timestamp");
  const t0 = new Date(String(rows[0]!["timestamp"] ?? 0)).getTime() || 0;
  const normalized = rows.map((r) => JSON.stringify({
    sql: r["sql"] ?? r["query"], durationMs: Number(r["durationMs"] ?? r["duration"] ?? 5), rowCount: r["rowCount"] !== undefined ? Number(r["rowCount"]) : -1,
    offsetMs: r["offsetMs"] !== undefined ? Number(r["offsetMs"]) : (new Date(String(r["timestamp"] ?? 0)).getTime() || 0) - t0,
  })).join("\n");
  const uploadId = uuid();
  const dir = path.resolve(appConfig.captureDir, "uploads");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uploadId}.jsonl`);
  writeFileSync(file, normalized);
  uploads.set(uploadId, { file, fileName: req.file.originalname, queryCount: rows.length });
  return { uploadId, fileName: req.file.originalname, queryCount: rows.length };
}));
dashboardRouter.post("/replay/start", wrap((req) => {
  const b = parseWith(z.object({ uploadId: z.string(), targetNode: z.string().optional(), speed: z.union([z.literal(0.5), z.literal(1), z.literal(2), z.literal(10)]).default(1), compareResults: z.boolean().default(true) }), req.body);
  const u = uploads.get(b.uploadId);
  if (!u) throw new NotFoundError("Upload not found — upload the capture file again");
  const run = replayQueries({ file: u.file, speed: b.speed, compare: b.compareResults });
  return { replayId: run.runId, status: "starting" };
}));
const statusView = (r: ReplayStats) => ({
  replayId: r.runId, status: r.status,
  progress: { current: r.executed + r.failed, total: r.total, percentage: r.total ? Math.round(((r.executed + r.failed) / r.total) * 1000) / 10 : 0 },
  stats: { queriesExecuted: r.executed, avgLatency: r.avgReplayMs, errors: r.failed, mismatches: r.mismatches },
  ...(r.currentQuery ? { currentQuery: r.currentQuery } : {}),
});
dashboardRouter.get("/replay/:id/status", wrap((req) => statusView(getReplayStats(req.params.id) as ReplayStats)));
dashboardRouter.post("/replay/:id/pause", wrap((req) => statusView(pauseReplay(req.params.id))));
dashboardRouter.post("/replay/:id/resume", wrap((req) => statusView(resumeReplay(req.params.id))));
dashboardRouter.get("/replay/:id/comparison", wrap((req) => {
  const r = getReplayStats(req.params.id) as ReplayStats;
  return {
    mismatches: r.comparisons.filter((c) => !c.rowCountMatches).map((c) => ({
      query: c.sql, originalResult: { rowCount: c.originalRowCount, durationMs: c.originalDurationMs }, replayResult: { rowCount: c.replayRowCount, durationMs: c.replayDurationMs },
      difference: `row count ${c.originalRowCount} → ${c.replayRowCount}, ${c.slowerBy >= 0 ? "+" : ""}${c.slowerBy}ms`,
    })),
  };
}));

/* ---------- settings ---------- */
dashboardRouter.get("/settings", wrap(() => ({
  nodes: getNodes().map((n) => {
    let host = n.id, port = 5432;
    try { const u = new URL(n.connectionString); host = u.hostname; port = Number(u.port || 5432); } catch { /* keep */ }
    return { id: n.id, name: n.id, host, port, role: n.role, isActive: true };
  }),
  thresholds: runtimeSettings.thresholds,
  ai: { ...runtimeSettings.ai, apiKeysConfigured: { gemini: aiEnabled.gemini(), huggingface: aiEnabled.huggingFace() } },
  liveUpdates: runtimeSettings.liveUpdates,
})));
dashboardRouter.put("/settings/thresholds", wrap((req) => {
  runtimeSettings.thresholds = parseWith(z.object({ slowQueryMs: z.number().int().min(1).max(60_000), replicaLagMs: z.number().int().min(10).max(600_000), anomalyDetectionWindow: z.number().int().min(50).max(100_000) }), req.body);
  return runtimeSettings.thresholds;
}));
dashboardRouter.put("/settings/ai", wrap((req) => {
  runtimeSettings.ai = parseWith(z.object({ geminiModel: z.string().min(1).max(100), embeddingModel: z.string().min(1).max(100) }), req.body);
  return runtimeSettings.ai;
}));
dashboardRouter.put("/settings/live-updates", wrap((req) => {
  runtimeSettings.liveUpdates = parseWith(z.object({ enabled: z.boolean() }), req.body).enabled;
  return { enabled: runtimeSettings.liveUpdates };
}));
