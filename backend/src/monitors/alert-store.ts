import { bus } from "../events";
import type { AnomalyAlert } from "../types/ai";
import { nowIso, uuid } from "../utils/helpers";

export type AlertSeverity = "CRITICAL" | "WARNING" | "INFO";
export type AlertType = "N_PLUS_1" | "REPLICA_LAG" | "VOLUME_SPIKE" | "SLOW_QUERY" | "NEW_PATTERN";

export interface DashboardAlert {
  id: string;
  severity: AlertSeverity;
  type: AlertType;
  message: string;
  details: { query?: string; detectedAt: string; score: number; affectedNodes?: string[] };
  acknowledged: boolean;
  note?: string;
}

const MAX = 1000;
const alerts: DashboardAlert[] = [];
const listeners = new Set<(a: DashboardAlert) => void>();

const TYPE: Record<AnomalyAlert["kind"], AlertType> = {
  n_plus_one: "N_PLUS_1",
  volume_spike: "VOLUME_SPIKE",
  new_query_shape: "NEW_PATTERN",
  latency_spike: "SLOW_QUERY",
};

export const pushAlert = (a: DashboardAlert): void => {
  alerts.unshift(a);
  if (alerts.length > MAX) alerts.length = MAX;
  listeners.forEach((l) => l(a));
};
export const onAlert = (l: (a: DashboardAlert) => void) => { listeners.add(l); return () => listeners.delete(l); };

bus.onEvent("anomaly:detected", (a) =>
  pushAlert({
    id: a.id,
    severity: a.score > 0.9 ? "CRITICAL" : a.score > 0.75 ? "WARNING" : "INFO",
    type: TYPE[a.kind] ?? "NEW_PATTERN",
    message: a.message,
    details: { query: a.sql, detectedAt: a.detectedAt, score: a.score },
    acknowledged: false,
  }),
);
bus.onEvent("lag:exceeded", ({ nodeId, lagMs, thresholdMs }) =>
  pushAlert({
    id: uuid(),
    severity: lagMs > thresholdMs * 3 ? "CRITICAL" : "WARNING",
    type: "REPLICA_LAG",
    message: `Replication lag on ${nodeId} is ${Math.round(lagMs)}ms (threshold ${thresholdMs}ms)`,
    details: { detectedAt: nowIso(), score: Math.min(1, lagMs / (thresholdMs * 4)), affectedNodes: [nodeId] },
    acknowledged: false,
  }),
);

const RANGE: Record<string, number> = { "1h": 3.6e6, "6h": 2.16e7, "24h": 8.64e7, "7d": 6.048e8 };

export const listAlerts = (opts: { severity?: string; timeRange?: string; limit?: number }): DashboardAlert[] => {
  const since = Date.now() - (RANGE[opts.timeRange ?? "24h"] ?? RANGE["24h"]!);
  const sev = opts.severity && opts.severity !== "all" ? opts.severity.toUpperCase() : null;
  return alerts
    .filter((a) => new Date(a.details.detectedAt).getTime() >= since && (!sev || a.severity === sev))
    .slice(0, Math.min(opts.limit ?? 50, 500));
};

export const acknowledgeAlert = (id: string, note?: string): DashboardAlert | null => {
  const a = alerts.find((x) => x.id === id);
  if (!a) return null;
  a.acknowledged = true;
  if (note) a.note = note;
  return a;
};

export const alertPatterns = (list: DashboardAlert[]) => {
  const dist = new Map<AlertType, number>();
  const freq = new Map<string, number>();
  for (const a of list) {
    dist.set(a.type, (dist.get(a.type) ?? 0) + 1);
    const h = `${String(new Date(a.details.detectedAt).getHours()).padStart(2, "0")}:00`;
    freq.set(h, (freq.get(h) ?? 0) + 1);
  }
  return {
    distribution: [...dist].map(([type, count]) => ({ type, count })),
    frequency: [...freq].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour.localeCompare(b.hour)),
  };
};
