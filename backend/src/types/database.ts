export type NodeRole = "primary" | "replica";

export interface DatabaseNode {
  id: string;
  role: NodeRole;
  connectionString: string;
  maxConnections: number;
}

export interface NodeHealth {
  nodeId: string;
  role: NodeRole;
  healthy: boolean;
  responseTimeMs: number;
  replicationLagMs: number | null;
  activeConnections: number;
  lastCheckedAt: string;
  error?: string;
}

export interface ConnectionPoolStats {
  nodeId: string;
  total: number;
  idle: number;
  waiting: number;
}

export interface TransactionState {
  sessionId: string;
  active: boolean;
  nodeId: string | null;
  savepoints: string[];
  startedAt: string | null;
}
