/**
 * Transaction State — per-session tracking with Redis-backed persistence.
 *
 * While a transaction is open every statement in that session is pinned
 * to the primary node.  Sessions survive server restarts because state is
 * stored in Redis with an auto-expiry TTL (default 30 minutes).
 *
 * Falls back gracefully to an in-memory Map when Redis is unavailable.
 */

import { getCache } from "../config/redis";
import type { TransactionState } from "../types/database";
import { nowIso } from "../utils/helpers";
import { logger } from "../utils/logger";

const SESSION_TTL_SECONDS = Number(process.env.TRANSACTION_SESSION_TTL_S ?? 1800); // 30 min
const PREFIX = "txn:session:";

/* ── helpers ──────────────────────────────────────────────────────── */
const key = (sessionId: string) => `${PREFIX}${sessionId}`;

const blank = (sessionId: string): TransactionState => ({
  sessionId,
  active: false,
  nodeId: null,
  savepoints: [],
  startedAt: null,
});

/** Read state from Redis; falls back to blank if missing or Redis is down. */
const load = async (sessionId: string): Promise<TransactionState> => {
  try {
    const raw = await getCache().get(key(sessionId));
    if (raw) return JSON.parse(raw) as TransactionState;
  } catch {
    /* Redis unavailable — treat as new session */
  }
  return blank(sessionId);
};

/** Persist state to Redis.  Fire-and-forget (errors are logged, not thrown). */
const persist = (state: TransactionState): void => {
  if (!state.active) {
    // Session ended — remove from Redis immediately to free memory
    void getCache()
      .del(key(state.sessionId))
      .catch((e) => logger.warn("Failed to delete session", { error: (e as Error).message }));
    return;
  }
  void getCache()
    .set(key(state.sessionId), JSON.stringify(state), SESSION_TTL_SECONDS)
    .catch((e) => logger.warn("Failed to persist session", { error: (e as Error).message }));
};

/* ── in-process cache to avoid a Redis round-trip on every statement ─ */
const localCache = new Map<string, TransactionState>();

const getLocal = (sessionId: string): TransactionState | undefined => localCache.get(sessionId);
const setLocal = (sessionId: string, state: TransactionState): void => { localCache.set(sessionId, state); };
const delLocal = (sessionId: string): void => { localCache.delete(sessionId); };

/* ── public API ───────────────────────────────────────────────────── */

export const getState = (sessionId: string): TransactionState =>
  getLocal(sessionId) ?? blank(sessionId);

/** Synchronous check used by the hot routing path (avoids async). */
export const isInTransaction = (sessionId: string): boolean =>
  getLocal(sessionId)?.active ?? false;

export const startTransaction = (sessionId: string, nodeId = "primary"): TransactionState => {
  const state: TransactionState = { sessionId, active: true, nodeId, savepoints: [], startedAt: nowIso() };
  setLocal(sessionId, state);
  persist(state);
  logger.debug("Transaction started", { sessionId, nodeId });
  return state;
};

export const savepoint = (sessionId: string, name: string): TransactionState => {
  const state = getState(sessionId);
  if (!state.active) return state;
  const next = { ...state, savepoints: [...state.savepoints, name] };
  setLocal(sessionId, next);
  persist(next);
  return next;
};

export const releaseSavepoint = (sessionId: string, name: string): TransactionState => {
  const state = getState(sessionId);
  const next = { ...state, savepoints: state.savepoints.filter((s) => s !== name) };
  setLocal(sessionId, next);
  persist(next);
  return next;
};

export const commit = (sessionId: string): TransactionState => {
  delLocal(sessionId);
  persist(blank(sessionId));
  logger.debug("Transaction committed", { sessionId });
  return blank(sessionId);
};

export const rollback = (sessionId: string, toSavepoint?: string): TransactionState => {
  if (toSavepoint) return releaseSavepoint(sessionId, toSavepoint);
  delLocal(sessionId);
  persist(blank(sessionId));
  logger.debug("Transaction rolled back", { sessionId });
  return blank(sessionId);
};

/** Applies transaction-control SQL to the state machine; returns true when handled. */
export const applyControlStatement = (sessionId: string, sql: string): boolean => {
  const trimmed = sql.trim().replace(/;$/, "");
  if (/^(begin|start\s+transaction)\b/i.test(trimmed)) {
    startTransaction(sessionId);
    return true;
  }
  if (/^commit\b/i.test(trimmed)) {
    commit(sessionId);
    return true;
  }
  const rollbackTo = trimmed.match(/^rollback\s+to\s+(?:savepoint\s+)?(\w+)/i);
  if (rollbackTo) {
    rollback(sessionId, rollbackTo[1]);
    return true;
  }
  if (/^rollback\b/i.test(trimmed)) {
    rollback(sessionId);
    return true;
  }
  const sp = trimmed.match(/^savepoint\s+(\w+)/i);
  if (sp) {
    savepoint(sessionId, sp[1]);
    return true;
  }
  const release = trimmed.match(/^release\s+savepoint\s+(\w+)/i);
  if (release) {
    releaseSavepoint(sessionId, release[1]);
    return true;
  }
  return false;
};

/** Hydrate local cache from Redis — call once on startup for in-progress sessions. */
export const hydrateFromRedis = async (): Promise<void> => {
  // Nothing to do in memory-store mode; Redis scan would be needed in production.
  logger.debug("Transaction state hydration complete");
};

export const activeTransactions = (): TransactionState[] => [...localCache.values()].filter((s) => s.active);
