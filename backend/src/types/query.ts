export type QueryType = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "DDL" | "TRANSACTION" | "UNKNOWN";

export interface ParsedQuery {
  sql: string;
  normalized: string;
  type: QueryType;
  tables: string[];
  isWrite: boolean;
  complexity: number;
  ast: unknown;
}

export type RouteTarget = "primary" | "replica";

export interface RoutingDecision {
  target: RouteTarget;
  nodeId: string;
  reason: string;
  parsed: ParsedQuery;
  decidedAt: string;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  durationMs: number;
  nodeId: string;
  target: RouteTarget;
  fields: string[];
}

export interface QueryPlan {
  sql: string;
  plan: string;
  estimatedCost: number;
}

export interface ExecutedQuery {
  id: string;
  sql: string;
  sessionId: string;
  decision: RoutingDecision;
  durationMs: number;
  rowCount: number;
  error?: string;
  executedAt: string;
}

export interface QueryStats {
  total: number;
  toPrimary: number;
  toReplica: number;
  writes: number;
  reads: number;
  errors: number;
  avgDurationMs: number;
}
