import type { TransactionState } from "../types/database";
import { nowIso } from "../utils/helpers";
import { logger } from "../utils/logger";

/**
 * Tracks BEGIN/COMMIT/ROLLBACK/SAVEPOINT per session. While a transaction is
 * open, every statement in that session is pinned to the primary node.
 */
const sessions = new Map<string, TransactionState>();

const blank = (sessionId: string): TransactionState => ({
  sessionId,
  active: false,
  nodeId: null,
  savepoints: [],
  startedAt: null,
});

export const getState = (sessionId: string): TransactionState =>
  sessions.get(sessionId) ?? blank(sessionId);

export const isInTransaction = (sessionId: string): boolean => getState(sessionId).active;

export const startTransaction = (sessionId: string, nodeId = "primary"): TransactionState => {
  const state: TransactionState = { sessionId, active: true, nodeId, savepoints: [], startedAt: nowIso() };
  sessions.set(sessionId, state);
  logger.debug("Transaction started", { sessionId, nodeId });
  return state;
};

export const savepoint = (sessionId: string, name: string): TransactionState => {
  const state = getState(sessionId);
  if (!state.active) return state;
  const next = { ...state, savepoints: [...state.savepoints, name] };
  sessions.set(sessionId, next);
  return next;
};

export const releaseSavepoint = (sessionId: string, name: string): TransactionState => {
  const state = getState(sessionId);
  const next = { ...state, savepoints: state.savepoints.filter((s) => s !== name) };
  sessions.set(sessionId, next);
  return next;
};

export const commit = (sessionId: string): TransactionState => {
  sessions.delete(sessionId);
  logger.debug("Transaction committed", { sessionId });
  return blank(sessionId);
};

export const rollback = (sessionId: string, toSavepoint?: string): TransactionState => {
  if (toSavepoint) return releaseSavepoint(sessionId, toSavepoint);
  sessions.delete(sessionId);
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

export const activeTransactions = (): TransactionState[] => [...sessions.values()];
