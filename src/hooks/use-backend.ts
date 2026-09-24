import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage, isBackendConfigured } from "@/lib/api";
import { useSim } from "@/lib/sim";

/** Status of the data feed: simulated / connecting / live / stale. */
export function useDataSource() {
  const source = useSim((s) => s.source);
  const lastUpdated = useSim((s) => s.lastUpdated);
  const error = useSim((s) => s.error);
  return { source, lastUpdated, error, live: source === "live" };
}

export function useDebounce<T>(value: T, ms = 500) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Dashboard metrics from the shared store (fed by REST + `metrics:update`). */
export function useDashboardMetrics() {
  const series = useSim((s) => s.series);
  const nodes = useSim((s) => s.nodes);
  const slow = useSim((s) => s.slow);
  const alerts = useSim((s) => s.alerts);
  return { series, nodes, slow, alerts, ...useDataSource() };
}
export function useNodeHealth() {
  return useSim((s) => s.nodes);
}

/** Run an async backend action with a pending flag and toast on error. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const ref = useRef(fn); ref.current = fn;
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    setPending(true);
    try { return await ref.current(...a); }
    catch (e) { toast.error(errorMessage(e)); return undefined; }
    finally { setPending(false); }
  }, []);
  return { run, pending };
}

/** Backend AI analysis, debounced; returns null when backend is unavailable. */
export interface RemoteSuggestion { type: "INDEX_SUGGESTION" | "REWRITE_PROPOSAL" | "WARNING"; message: string; confidence: number; estimatedImprovement?: string; autoFixAvailable?: boolean; sql?: string }
export function useAIAnalysis(sql: string, executionTime?: number) {
  const debounced = useDebounce(sql, 500);
  const [data, setData] = useState<RemoteSuggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!isBackendConfigured() || !debounced.trim()) { setData(null); return; }
    let cancelled = false;
    setLoading(true);
    api<{ suggestions: RemoteSuggestion[] }>("/api/ai/analyze", { method: "POST", json: { sql: debounced, executionTime }, retries: 1 })
      .then((r) => !cancelled && setData(r.suggestions))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [debounced, executionTime]);
  return { data, loading };
}

export interface PoolNodePressure {
  nodeId: string;
  role: "primary" | "replica";
  connections: { total: number; idle: number; waiting: number; active: number; pressure: number };
  circuitBreaker: { state: "CLOSED" | "OPEN" | "HALF_OPEN"; failures: number };
  healthy: boolean;
  responseTimeMs: number;
}

/** Polls /api/pool/pressure every 3s — real-time connection pool health. */
export function usePoolPressure() {
  const [data, setData] = useState<PoolNodePressure[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isBackendConfigured()) { setLoading(false); return; }
    let cancelled = false;
    const fetch = () =>
      api<{ nodes: PoolNodePressure[] }>("/api/pool/pressure", { retries: 1 })
        .then((r) => !cancelled && setData(r.nodes))
        .catch(() => {/* keep stale */})
        .finally(() => !cancelled && setLoading(false));

    void fetch();
    const t = setInterval(fetch, 3_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return { nodes: data, loading };
}

export interface QuerySafetyData {
  isSafe: boolean;
  riskScore: number;
  riskLevel: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reasons: string[];
  suggestions: string[];
  vectorAnomaly?: {
    similarityScore: number;
    isAnomalous: boolean;
  };
  evaluatedBy: "deepseek-bedrock" | "cached" | "heuristic-fallback";
  evaluatedAt: string;
}

export function useQuerySafety(sql: string) {
  const debounced = useDebounce(sql, 800);
  const [safety, setSafety] = useState<QuerySafetyData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isBackendConfigured() || !debounced.trim()) {
      setSafety(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api<{ safety: QuerySafetyData }>("/api/ai/safety", {
      method: "POST",
      json: { sql: debounced },
      retries: 1,
    })
      .then((r) => !cancelled && setSafety(r.safety))
      .catch(() => !cancelled && setSafety(null))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [debounced]);

  return { safety, loading };
}
