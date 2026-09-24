import { appConfig } from "../config/app";
import { bus } from "../events";
import { detectAnomaly } from "../ai/anomaly";
import { analyzeQuery } from "../ai/optimizer";
import { recordQueryMetrics } from "../monitors/metrics-collector";
import { writeQuery as captureQuery } from "../replay/capture";
import type { ExecutedQuery, QueryResult, QueryStats, RoutingDecision } from "../types/query";
import { QueryError } from "../utils/errors";
import { nowIso, uuid } from "../utils/helpers";
import { logger } from "../utils/logger";
import { assertSafeSql } from "../utils/validators";
import { parseQuery } from "./parser";
import { getPoolForQuery, runOnNode } from "./pool-manager";
import { applyControlStatement, isInTransaction } from "./transaction-state";

const stats: QueryStats = {
  total: 0,
  toPrimary: 0,
  toReplica: 0,
  writes: 0,
  reads: 0,
  errors: 0,
  avgDurationMs: 0,
};

const history: ExecutedQuery[] = [];
const HISTORY_LIMIT = 500;

export interface RouteOptions {
  sessionId?: string;
  forcePrimary?: boolean;
}

/** Pure decision: which node should serve this statement, and why. */
export const routeQuery = (sql: string, options: RouteOptions = {}): RoutingDecision => {
  const sessionId = options.sessionId ?? "default";
  const parsed = parseQuery(sql);

  let target: "primary" | "replica" = "replica";
  let reason = "Read-only query outside a transaction — served by a replica";

  if (options.forcePrimary) {
    target = "primary";
    reason = "Caller requested primary explicitly";
  } else if (parsed.type === "TRANSACTION") {
    target = "primary";
    reason = "Transaction control statement — pinned to primary";
  } else if (isInTransaction(sessionId)) {
    target = "primary";
    reason = "Session has an open transaction — pinned to primary";
  } else if (parsed.isWrite) {
    target = "primary";
    reason = `${parsed.type} statement must run on primary`;
  }

  const node = getPoolForQuery(target);
  if (target === "replica" && node.role === "primary") {
    reason = "No healthy replica within lag threshold — failed over to primary";
  }

  return {
    target: node.role,
    nodeId: node.id,
    reason,
    parsed,
    decidedAt: nowIso(),
  };
};

export const executeQuery = async (
  sql: string,
  params: unknown[] = [],
  options: RouteOptions = {},
): Promise<{ result: QueryResult; decision: RoutingDecision }> => {
  assertSafeSql(sql);
  const sessionId = options.sessionId ?? "default";
  const decision = routeQuery(sql, options);
  const id = uuid();

  try {
    const raw = await runOnNode(decision.nodeId, sql, params, decision.parsed.tables);
    applyControlStatement(sessionId, sql);

    const result: QueryResult = {
      rows: raw.rows,
      rowCount: raw.rowCount,
      durationMs: raw.durationMs,
      nodeId: decision.nodeId,
      target: decision.target,
      fields: raw.fields,
    };

    updateStats(decision, raw.durationMs, false);
    const executed: ExecutedQuery = {
      id,
      sql,
      sessionId,
      decision,
      durationMs: raw.durationMs,
      rowCount: raw.rowCount,
      executedAt: nowIso(),
    };
    remember(executed);

    // Fire-and-forget observability work; never blocks the caller's response.
    void afterQuery(executed);

    return { result, decision };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStats(decision, 0, true);
    const executed: ExecutedQuery = {
      id,
      sql,
      sessionId,
      decision,
      durationMs: 0,
      rowCount: 0,
      error: message,
      executedAt: nowIso(),
    };
    remember(executed);
    void recordQueryMetrics({
      sql,
      normalized: decision.parsed.normalized,
      durationMs: 0,
      rowCount: 0,
      nodeId: decision.nodeId,
      target: decision.target,
      isWrite: decision.parsed.isWrite,
      error: message,
    });
    logger.error("Query execution failed", { sql, nodeId: decision.nodeId, error: message });
    throw new QueryError(message, { nodeId: decision.nodeId });
  }
};

const afterQuery = async (executed: ExecutedQuery): Promise<void> => {
  const { decision, durationMs, sql, rowCount } = executed;
  try {
    await recordQueryMetrics({
      sql,
      normalized: decision.parsed.normalized,
      durationMs,
      rowCount,
      nodeId: decision.nodeId,
      target: decision.target,
      isWrite: decision.parsed.isWrite,
    });
    captureQuery(executed);
    bus.emitEvent("query:executed", executed);
    await detectAnomaly(sql, decision.parsed.normalized, durationMs);

    if (durationMs > appConfig.thresholds.slowQueryMs) {
      const explain = await safeExplain(sql, decision);
      await analyzeQuery({ sql, executionTimeMs: durationMs, explainPlan: explain });
    }
  } catch (error) {
    logger.warn("Post-query analysis failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const safeExplain = async (sql: string, decision: RoutingDecision): Promise<string | undefined> => {
  if (decision.parsed.type !== "SELECT") return undefined;
  try {
    const raw = await runOnNode(decision.nodeId, `EXPLAIN ANALYZE ${sql}`, [], decision.parsed.tables);
    return raw.rows.map((row) => String(Object.values(row)[0])).join("\n");
  } catch {
    return undefined;
  }
};

const updateStats = (decision: RoutingDecision, durationMs: number, failed: boolean): void => {
  stats.total += 1;
  if (failed) stats.errors += 1;
  if (decision.target === "primary") stats.toPrimary += 1;
  else stats.toReplica += 1;
  if (decision.parsed.isWrite) stats.writes += 1;
  else stats.reads += 1;
  stats.avgDurationMs =
    Math.round(((stats.avgDurationMs * (stats.total - 1) + durationMs) / stats.total) * 100) / 100;
};

const remember = (executed: ExecutedQuery): void => {
  history.unshift(executed);
  if (history.length > HISTORY_LIMIT) history.pop();
};

export const getQueryStats = (): QueryStats => ({ ...stats });

export const getQueryHistory = (limit = 50): ExecutedQuery[] => history.slice(0, limit);
