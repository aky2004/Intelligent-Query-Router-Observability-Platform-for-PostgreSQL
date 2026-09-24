export interface IndexRecommendation {
  table: string;
  columns: string[];
  statement: string;
  rationale: string;
}

export interface OptimizationSuggestion {
  sql: string;
  summary: string;
  severity: "info" | "warning" | "critical";
  indexes: IndexRecommendation[];
  rewrite?: string;
  warnings: string[];
  cached: boolean;
  generatedAt: string;
}

export type AnomalyKind = "n_plus_one" | "volume_spike" | "new_query_shape" | "latency_spike";

export interface AnomalyAlert {
  id: string;
  kind: AnomalyKind;
  score: number;
  message: string;
  sql: string;
  normalized: string;
  detectedAt: string;
}

export interface QueryPattern {
  normalized: string;
  embedding: number[];
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface NLQuery {
  question: string;
  schema: string;
}

export interface NLQueryResult {
  question: string;
  sql: string;
  confidence: number;
  explanation: string;
  routing: "primary" | "replica";
  valid: boolean;
  validationErrors: string[];
}
