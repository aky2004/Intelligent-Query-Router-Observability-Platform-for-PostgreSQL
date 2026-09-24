// Live simulation engine: mirrors the backend's socket events (metrics:update,
// alert:new, node:status) so the dashboard works without a running server.
import { useSyncExternalStore } from "react";

export type NodeStatus = "healthy" | "degraded" | "down";
export type Severity = "critical" | "warning" | "info";
export type AlertReason = "N+1 pattern" | "Volume spike" | "New pattern" | "Slow query" | "Replica lag";

export interface DbNode {
  id: string;
  role: "primary" | "replica";
  host: string;
  status: NodeStatus;
  lagMs: number;
  connections: number;
  maxConnections: number;
  latencyMs: number;
  queriesRouted: number;
}
export interface MetricPoint {
  t: number;
  qps: number;
  latency: number;
  p95: number;
  errorRate: number;
  connections: number;
  primaryPct: number;
  lag1: number;
  lag2: number;
}
export interface Alert {
  id: string;
  t: number;
  severity: Severity;
  reason: AlertReason;
  node: string;
  query: string;
  score: number;
  acknowledged: boolean;
}
export interface SlowQuery {
  id: string;
  t: number;
  sql: string;
  durationMs: number;
  node: string;
  rows: number;
}

const SAMPLE_QUERIES = [
  "SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC",
  "SELECT u.id, u.email, COUNT(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id",
  "SELECT * FROM products WHERE lower(name) LIKE '%widget%'",
  "UPDATE inventory SET stock = stock - 1 WHERE sku = $1",
  "SELECT * FROM events WHERE payload->>'type' = 'click' AND created_at > now() - interval '1 day'",
  "SELECT id FROM sessions WHERE token = $1",
  "INSERT INTO audit_log (actor, action, meta) VALUES ($1, $2, $3)",
  "SELECT p.*, c.name FROM products p JOIN categories c ON c.id = p.category_id WHERE c.slug = $1",
];

export type DataSource = "simulated" | "connecting" | "live" | "stale";

interface State {
  nodes: DbNode[];
  series: MetricPoint[];
  alerts: Alert[];
  slow: SlowQuery[];
  connected: boolean;
  thresholds: { slowMs: number; lagMs: number; window: number };
  source: DataSource;
  lastUpdated: number | null;
  error: string | null;
}

let seq = 0;
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;

function initial(): State {
  const now = Date.now();
  const series: MetricPoint[] = [];
  for (let i = 90; i > 0; i--) series.push(point(now - i * 2000, series[series.length - 1]));
  const alerts: Alert[] = [];
  for (let i = 0; i < 14; i++) alerts.push(makeAlert(now - rnd(60_000, 3_600_000 * 20)));
  alerts.sort((a, b) => b.t - a.t);
  const slow: SlowQuery[] = [];
  for (let i = 0; i < 8; i++) slow.push(makeSlow(now - rnd(5_000, 600_000), 100));
  slow.sort((a, b) => b.t - a.t);
  return {
    connected: true,
    source: "simulated",
    lastUpdated: null,
    error: null,
    thresholds: { slowMs: 100, lagMs: 1000, window: 1000 },
    series,
    alerts,
    slow,
    nodes: [
      { id: "primary", role: "primary", host: "pg-primary.internal:5432", status: "healthy", lagMs: 0, connections: 42, maxConnections: 200, latencyMs: 3.1, queriesRouted: 182_340 },
      { id: "replica-1", role: "replica", host: "pg-replica-1.internal:5432", status: "healthy", lagMs: 120, connections: 31, maxConnections: 150, latencyMs: 2.4, queriesRouted: 401_220 },
      { id: "replica-2", role: "replica", host: "pg-replica-2.internal:5432", status: "healthy", lagMs: 180, connections: 28, maxConnections: 150, latencyMs: 2.7, queriesRouted: 398_810 },
    ],
  };
}

function point(t: number, prev?: MetricPoint): MetricPoint {
  const wave = Math.sin(t / 40_000) * 60;
  const qps = Math.max(40, (prev?.qps ?? 420) * 0.7 + (420 + wave + rnd(-40, 40)) * 0.3 + (Math.random() < 0.03 ? rnd(200, 500) : 0));
  const latency = Math.max(1, (prev?.latency ?? 12) * 0.7 + rnd(8, 18) * 0.3);
  return {
    t,
    qps,
    latency,
    p95: latency * rnd(2.8, 4.2),
    errorRate: Math.max(0, Math.random() < 0.05 ? rnd(1, 4) : rnd(0, 0.6)),
    connections: Math.round(rnd(95, 125)),
    primaryPct: rnd(22, 32),
    lag1: Math.max(0, (prev?.lag1 ?? 120) * 0.8 + rnd(40, 260) * 0.2 + (Math.random() < 0.02 ? 1400 : 0)),
    lag2: Math.max(0, (prev?.lag2 ?? 180) * 0.8 + rnd(60, 320) * 0.2),
  };
}

function makeAlert(t: number): Alert {
  const reason = pick<AlertReason>(["N+1 pattern", "Volume spike", "New pattern", "Slow query", "Replica lag"]);
  const severity: Severity = reason === "Replica lag" || Math.random() < 0.2 ? "critical" : Math.random() < 0.55 ? "warning" : "info";
  return { id: uid(), t, severity, reason, node: pick(["primary", "replica-1", "replica-2"]), query: pick(SAMPLE_QUERIES), score: rnd(0.62, 0.99), acknowledged: false };
}
function makeSlow(t: number, min: number): SlowQuery {
  const sql = pick(SAMPLE_QUERIES);
  return { id: uid(), t, sql, durationMs: rnd(min, min * 12), node: sql.startsWith("SELECT") ? pick(["replica-1", "replica-2"]) : "primary", rows: Math.round(rnd(1, 50_000)) };
}

let state: State | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function get(): State {
  if (!state) state = initial();
  return state;
}
function set(patch: Partial<State>) {
  state = { ...get(), ...patch };
  listeners.forEach((l) => l());
}

function tick() {
  const s = get();
  if (!s.connected || s.source !== "simulated") return;
  const last = s.series[s.series.length - 1];
  const p = point(Date.now(), last);
  const series = [...s.series.slice(-179), p];
  const nodes = s.nodes.map((n) => {
    const lagMs = n.role === "primary" ? 0 : n.id === "replica-1" ? p.lag1 : p.lag2;
    const status: NodeStatus = lagMs > s.thresholds.lagMs ? "degraded" : "healthy";
    return {
      ...n,
      lagMs,
      status,
      connections: Math.max(5, Math.round(n.connections + rnd(-3, 3))),
      latencyMs: Math.max(0.8, n.latencyMs * 0.8 + rnd(1.5, 4) * 0.2),
      queriesRouted: n.queriesRouted + Math.round(p.qps * 2 * (n.role === "primary" ? p.primaryPct / 100 : (1 - p.primaryPct / 100) / 2)),
    };
  });
  let alerts = s.alerts;
  if (Math.random() < 0.12) alerts = [makeAlert(Date.now()), ...alerts].slice(0, 300);
  let slow = s.slow;
  if (Math.random() < 0.2) slow = [makeSlow(Date.now(), s.thresholds.slowMs), ...slow].slice(0, 100);
  set({ series, nodes, alerts, slow });
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer && typeof window !== "undefined") timer = setInterval(tick, 2000);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

let serverSnapshot: State | null = null;
export function useSim<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => sel(get()),
    () => sel((serverSnapshot ??= get())),
  );
}

export const sim = {
  acknowledge(id: string) {
    set({ alerts: get().alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)) });
  },
  setConnected(connected: boolean) {
    set({ connected });
  },
  setThresholds(t: State["thresholds"]) {
    set({ thresholds: t });
  },
  setNodes(nodes: DbNode[]) {
    set({ nodes });
  },
  hydrate(patch: Partial<State>) {
    set(patch);
  },
  get,
  subscribe,
  sampleQueries: SAMPLE_QUERIES,
};
