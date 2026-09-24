import type { AnomalyAlert } from "./ai";
import type { NodeHealth } from "./database";
import type { MetricsSnapshot } from "./metrics";
import type { QueryResult } from "./query";

export interface ClientToServerEvents {
  "subscribe:metrics": (payload: { intervalMs?: number }) => void;
  "unsubscribe:metrics": () => void;
  "subscribe:alerts": () => void;
  "editor:join": (p: { room: string; user?: { id: string } & Record<string, unknown> }) => void;
  "editor:leave": (p: { room: string; userId: string }) => void;
  "editor:sync": (p: { room: string; text: string; from: string }) => void;
  "cursor:update": (p: { room: string; peer: Record<string, unknown> }) => void;
  "execute:query": (
    payload: { sql: string; sessionId?: string },
    ack?: (response: { success: boolean; data?: QueryResult; error?: string }) => void,
  ) => void;
}

export interface ServerToClientEvents {
  "metrics:update": (snapshot: MetricsSnapshot | { queriesPerSecond: number; activeConnections: number; timestamp: string }) => void;
  "metrics:timeseries": (p: { metric: "throughput" | "latency"; dataPoint: { timestamp: string; value: number } }) => void;
  "node:status": (p: { nodeId: string; status: string; timestamp: string }) => void;
  "alert:new": (a: unknown) => void;
  "replay:progress": (p: unknown) => void;
  "replay:complete": (p: unknown) => void;
  "user:joined": (p: { room: string; user?: unknown }) => void;
  "user:left": (p: { room: string; userId: string }) => void;
  "editor:sync": (p: { room: string; text: string; from: string }) => void;
  "cursor:update": (p: { room: string; peer: Record<string, unknown> }) => void;
  "health:update": (nodes: NodeHealth[]) => void;
  "alert:anomaly": (alert: AnomalyAlert) => void;
  "query:executed": (payload: { sql: string; result?: QueryResult; error?: string }) => void;
}

export interface SocketData {
  userId: string | null;
  sessionId: string;
}
