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

export const simulate =
  (process.env.SIMULATE_DB ?? "true").toLowerCase() === "true" || !process.env.PRIMARY_DATABASE_URL;

const primaryUrl = process.env.PRIMARY_DATABASE_URL ?? "postgresql://sim:sim@primary:5432/sim";
const replicaUrls = parseReplicas(process.env.REPLICA_DATABASE_URLS);
const simulatedReplicas = ["postgresql://sim:sim@replica1:5432/sim", "postgresql://sim:sim@replica2:5432/sim"];

export const databaseConfig = {
  simulate,
  maxConnectionsPerNode: 10,
  statementTimeoutMs: 15_000,
  nodes: [
    { id: "primary", role: "primary", connectionString: primaryUrl, maxConnections: 20 },
    ...(replicaUrls.length ? replicaUrls : simulate ? simulatedReplicas : []).map((url, i) => ({
      id: `replica-${i + 1}`,
      role: "replica" as const,
      connectionString: url,
      maxConnections: 10,
    })),
  ] as DatabaseNode[],
  lagThresholdMs: appConfig.thresholds.replicaLagMs,
};
