// Connects the shared store to the real backend (REST + Socket.io).
// Falls back to simulated data when no backend is configured or reachable,
// and keeps cached backend data (marked "stale") if the backend drops out.
import { toast } from "sonner";
import { api, errorMessage, isBackendConfigured } from "@/lib/api";
import { socketService } from "@/lib/socket";
import { sim, type Alert, type AlertReason, type DbNode, type MetricPoint, type Severity, type SlowQuery } from "@/lib/sim";

/* ---------- backend response shapes ---------- */
interface DashboardRes {
  connections: { total: number; active: number; idle: number };
  queriesPerSecond: number;
  avgLatency: string;
  errorRate: string;
  routingDistribution: { name: string; value: number }[];
  queryVolume: { time: string; queries: number }[];
  slowQueries: { query: string; node: string; duration: string; timestamp: string }[];
  activeAlerts: { id: string | number; severity: string; message: string; time: string }[];
}
interface NodeRes {
  id: string; name: string; role: "primary" | "replica"; status: "healthy" | "degraded" | "unhealthy";
  poolUsage: { current: number; max: number }; throughput: number; avgLatency: number; replicaLag?: number | null; lastChecked: string; host?: string;
}
export interface AlertRes {
  id: string; severity: "CRITICAL" | "WARNING" | "INFO"; type: string; message: string;
  details: { query?: string; detectedAt: string; score: number; affectedNodes?: string[] }; acknowledged: boolean;
}
interface Point { timestamp: string | number; value: number | null }
interface TimeseriesRes { throughput: Point[]; latency: Point[]; replicaLag: Point[]; errorRate: Point[] }

/* ---------- mappers ---------- */
const num = (s: string | number) => parseFloat(String(s)) || 0;
const durMs = (s: string) => (/ms$/.test(s) ? num(s) : /s$/.test(s) ? num(s) * 1000 : num(s));
const REASON: Record<string, AlertReason> = { N_PLUS_1: "N+1 pattern", REPLICA_LAG: "Replica lag", VOLUME_SPIKE: "Volume spike", SLOW_QUERY: "Slow query", NEW_PATTERN: "New pattern" };

export const mapNode = (n: NodeRes): DbNode => ({
  id: n.name ?? n.id, role: n.role, host: n.host ?? n.id, status: n.status === "unhealthy" ? "down" : n.status,
  lagMs: n.replicaLag ?? 0, connections: n.poolUsage.current, maxConnections: n.poolUsage.max, latencyMs: n.avgLatency,
  queriesRouted: sim.get().nodes.find((x) => x.id === (n.name ?? n.id))?.queriesRouted ?? 0,
});
export const mapAlert = (a: AlertRes): Alert => ({
  id: a.id, t: new Date(a.details.detectedAt).getTime(), severity: a.severity.toLowerCase() as Severity,
  reason: REASON[a.type] ?? "New pattern", node: a.details.affectedNodes?.[0] ?? "primary",
  query: a.details.query ?? a.message, score: a.details.score, acknowledged: a.acknowledged,
});
const lastPoint = (): MetricPoint => sim.get().series.at(-1) ?? { t: Date.now(), qps: 0, latency: 0, p95: 0, errorRate: 0, connections: 0, primaryPct: 0, lag1: 0, lag2: 0 };

function applyDashboard(d: DashboardRes) {
  const base = lastPoint();
  const primaryPct = d.routingDistribution.find((r) => /primary/i.test(r.name))?.value ?? base.primaryPct;
  const now = Date.now();
  const series = d.queryVolume.length
    ? d.queryVolume.map((v, i) => ({ ...base, t: now - (d.queryVolume.length - 1 - i) * 2000, qps: v.queries }))
    : sim.get().series;
  series.push({ ...base, t: now, qps: d.queriesPerSecond, latency: num(d.avgLatency), p95: num(d.avgLatency) * 3, errorRate: num(d.errorRate), connections: d.connections.active, primaryPct });
  const slow: SlowQuery[] = d.slowQueries.map((q, i) => ({ id: `slow-${i}-${q.timestamp}`, t: new Date(q.timestamp).getTime() || now, sql: q.query, node: q.node, durationMs: durMs(q.duration), rows: 0 }));
  sim.hydrate({ series: series.slice(-180), slow });
}

export function applyTimeseries(ts: TimeseriesRes) {
  const byT = new Map<number, MetricPoint>();
  const base = lastPoint();
  const put = (pts: Point[], k: keyof MetricPoint) => pts.forEach((p) => {
    if (p.value == null) return;
    const t = new Date(p.timestamp).getTime();
    byT.set(t, { ...(byT.get(t) ?? { ...base, t }), [k]: p.value });
  });
  put(ts.throughput, "qps"); put(ts.latency, "latency"); put(ts.replicaLag, "lag1"); put(ts.errorRate, "errorRate");
  if (byT.size) sim.hydrate({ series: [...byT.values()].sort((a, b) => a.t - b.t).slice(-180) });
}

/* ---------- endpoints ---------- */
export const endpoints = {
  dashboard: () => api<DashboardRes>("/api/metrics/dashboard"),
  nodes: () => api<{ nodes: NodeRes[] }>("/api/nodes", { retries: 1 }),
  timeseries: (start: number, end: number, interval: string) => api<TimeseriesRes>(`/api/metrics/timeseries?start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}&interval=${interval}`),
  anomalies: (severity: string, timeRange: string) => api<{ alerts: AlertRes[] }>(`/api/anomalies?severity=${severity}&timeRange=${timeRange}&limit=50`, { retries: 1 }),
  acknowledge: (id: string, note?: string) => api(`/api/anomalies/${encodeURIComponent(id)}/acknowledge`, { method: "POST", json: { note } }),
};

/* ---------- controller ---------- */
let started = false;
let timers: ReturnType<typeof setInterval>[] = [];
let unsubs: (() => void)[] = [];

const touch = () => sim.hydrate({ source: "live", lastUpdated: Date.now(), error: null });
const fail = (e: unknown) => {
  const s = sim.get();
  // keep cached backend data if we had it; otherwise resume simulation
  sim.hydrate({ source: s.lastUpdated ? "stale" : "simulated", error: errorMessage(e) });
};

async function pollNodes() {
  try { const r = await endpoints.nodes(); sim.hydrate({ nodes: r.nodes.map(mapNode) }); touch(); } catch (e) { fail(e); }
}
async function pollAlerts() {
  try { const r = await endpoints.anomalies("all", "24h"); sim.hydrate({ alerts: r.alerts.map(mapAlert) }); touch(); } catch (e) { fail(e); }
}

function beep() {
  try {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); o.frequency.value = 880; o.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch { /* audio unavailable */ }
}

function wireSocket() {
  socketService.connect();
  unsubs = [
    socketService.subscribe("metrics:update", (p: { queriesPerSecond?: number; activeConnections?: number; timestamp?: string }) => {
      const pt = { ...lastPoint(), t: p.timestamp ? new Date(p.timestamp).getTime() : Date.now(), qps: p.queriesPerSecond ?? lastPoint().qps, connections: p.activeConnections ?? lastPoint().connections };
      sim.hydrate({ series: [...sim.get().series.slice(-179), pt] }); touch();
    }),
    socketService.subscribe("metrics:timeseries", (p: { metric: "throughput" | "latency"; dataPoint: Point }) => {
      const k = p.metric === "throughput" ? "qps" : "latency";
      const pt = { ...lastPoint(), t: new Date(p.dataPoint.timestamp).getTime(), [k]: p.dataPoint.value ?? 0 };
      sim.hydrate({ series: [...sim.get().series.slice(-179), pt] }); touch();
    }),
    socketService.subscribe("node:status", (p: { nodeId: string; status: string }) => {
      const status = p.status === "unhealthy" ? "down" : (p.status as DbNode["status"]);
      sim.hydrate({ nodes: sim.get().nodes.map((n) => (n.id === p.nodeId ? { ...n, status } : n)) });
    }),
    socketService.subscribe("alert:new", (a: AlertRes) => {
      const alert = mapAlert(a);
      sim.hydrate({ alerts: [alert, ...sim.get().alerts].slice(0, 300) });
      if (alert.severity === "critical") { toast.error(`${alert.reason} on ${alert.node}`, { description: a.message }); beep(); }
      else toast(`${alert.reason} on ${alert.node}`, { description: a.message });
    }),
    socketService.subscribe("alert:resolved", (p: { alertId: string }) => {
      sim.hydrate({ alerts: sim.get().alerts.map((a) => (a.id === p.alertId ? { ...a, acknowledged: true } : a)) });
    }),
  ];
}

export async function startLive() {
  if (started || typeof window === "undefined") return;
  if (!isBackendConfigured()) { sim.hydrate({ source: "simulated", error: null }); return; }
  started = true;
  sim.hydrate({ source: "connecting", error: null });
  try {
    const d = await endpoints.dashboard();
    applyDashboard(d);
    touch();
    void endpoints.timeseries(Date.now() - 6 * 60_000, Date.now(), "2s").then(applyTimeseries).catch(() => {});
    await Promise.all([pollNodes(), pollAlerts()]);
    wireSocket();
    timers = [setInterval(pollNodes, 5_000), setInterval(pollAlerts, 30_000)];
  } catch (e) {
    started = false;
    fail(e);
    toast.error(errorMessage(e), { description: "Showing simulated data instead." });
  }
}

export function stopLive() {
  timers.forEach(clearInterval); timers = [];
  unsubs.forEach((u) => u()); unsubs = [];
  socketService.disconnect();
  started = false;
}

export async function retryLive() {
  stopLive();
  await startLive();
}

export const isLive = () => sim.get().source === "live";
