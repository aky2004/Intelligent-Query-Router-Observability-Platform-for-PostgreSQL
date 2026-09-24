// Clean store for live router state.
// No mock/fake alerts, mock queries, or pre-baked fake nodes are injected.
// State begins pristine for fresh users and hydrates from the real backend.
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

function initial(): State {
  return {
    connected: true,
    source: "connecting",
    lastUpdated: null,
    error: null,
    thresholds: { slowMs: 100, lagMs: 1000, window: 1000 },
    series: [],
    alerts: [],
    slow: [],
    nodes: [],
  };
}

let state: State | null = null;
const listeners = new Set<() => void>();

function get(): State {
  if (!state) state = initial();
  return state;
}

function set(patch: Partial<State>) {
  state = { ...get(), ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
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
  reset() {
    state = initial();
    listeners.forEach((l) => l());
  },
  get,
  subscribe,
  sampleQueries: [
    "SELECT 1;",
    "SELECT current_database(), current_user, version();",
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';",
  ],
};
