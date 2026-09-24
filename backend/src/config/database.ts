import type { DatabaseNode } from "../types/database";
import { appConfig } from "./app";

const parseReplicas = (raw: string | undefined): string[] => {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
};

/**
 * simulate=true  → use in-memory simulated clients (local demo / CI)
 * simulate=false → use real PostgreSQL connections (production)
 *
 * In production mode we start with ZERO nodes so every user must connect
 * their own database via Settings → Database Nodes (Method B onboarding).
 * If PRIMARY_DATABASE_URL is set in .env it is loaded as a convenience for
 * self-hosted single-tenant deployments.
 */
export const simulate =
  process.env.SIMULATE_DB?.toLowerCase() === "true" ||
  (process.env.SIMULATE_DB === undefined && !process.env.PRIMARY_DATABASE_URL);

const primaryUrl = process.env.PRIMARY_DATABASE_URL ?? null;
const replicaUrls = parseReplicas(process.env.REPLICA_DATABASE_URLS);

// Simulated dummy nodes — used only when simulate=true (demo / local dev)
const simulatedNodes: DatabaseNode[] = [
  { id: "primary", role: "primary", connectionString: "postgresql://sim:sim@primary:5432/sim", maxConnections: 20 },
  { id: "replica-1", role: "replica", connectionString: "postgresql://sim:sim@replica1:5432/sim", maxConnections: 10 },
  { id: "replica-2", role: "replica", connectionString: "postgresql://sim:sim@replica2:5432/sim", maxConnections: 10 },
];

// Real nodes — empty by default in production; users add them via the UI
const realNodes: DatabaseNode[] = [
  ...(primaryUrl
    ? [{ id: "primary", role: "primary" as const, connectionString: primaryUrl, maxConnections: 20 }]
    : []),
  ...replicaUrls.map((url, i) => ({
    id: `replica-${i + 1}`,
    role: "replica" as const,
    connectionString: url,
    maxConnections: 10,
  })),
];

export const databaseConfig = {
  simulate,
  maxConnectionsPerNode: 10,
  statementTimeoutMs: 15_000,
  nodes: simulate ? simulatedNodes : realNodes,
  lagThresholdMs: appConfig.thresholds.replicaLagMs,
};
