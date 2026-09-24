export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

export interface MetricsSnapshot {
  windowMs: number;
  queriesPerMinute: number;
  avgDurationMs: number;
  p95DurationMs: number;
  errorRate: number;
  primaryShare: number;
  replicaShare: number;
  slowQueryCount: number;
  collectedAt: string;
}

export interface SlowQueryRecord {
  sql: string;
  durationMs: number;
  nodeId: string;
  occurredAt: string;
}

export interface QueryMetricInput {
  sql: string;
  normalized: string;
  durationMs: number;
  rowCount: number;
  nodeId: string;
  target: "primary" | "replica";
  isWrite: boolean;
  error?: string;
}
