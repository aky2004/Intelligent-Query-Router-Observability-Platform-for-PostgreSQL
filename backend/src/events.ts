import { EventEmitter } from "events";
import type { AnomalyAlert } from "./types/ai";
import type { NodeHealth } from "./types/database";
import type { ExecutedQuery } from "./types/query";

/**
 * Internal event bus. Keeps modules decoupled: anomaly/health emit here and
 * the Socket.io layer subscribes, so no module imports the API layer.
 */
interface Events {
  "anomaly:detected": (alert: AnomalyAlert) => void;
  "health:updated": (nodes: NodeHealth[]) => void;
  "query:executed": (query: ExecutedQuery) => void;
  "replay:progress": (p: { replayId: string; current: number; total: number; currentQuery?: { sql: string; startTime: string } }) => void;
  "replay:complete": (p: { replayId: string; summary: { totalQueries: number; avgLatency: number; errors: number; mismatches: number } }) => void;
  "lag:exceeded": (payload: { nodeId: string; lagMs: number; thresholdMs: number }) => void;
}

class TypedBus extends EventEmitter {
  emitEvent<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    super.emit(event, ...args);
  }
  onEvent<K extends keyof Events>(event: K, listener: Events[K]): void {
    super.on(event, listener as (...args: unknown[]) => void);
  }
}

export const bus = new TypedBus();
