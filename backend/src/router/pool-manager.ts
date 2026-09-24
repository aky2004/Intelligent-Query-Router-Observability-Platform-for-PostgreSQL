import { Pool } from "pg";
import { databaseConfig } from "../config/database";
import type { ConnectionPoolStats, DatabaseNode, NodeHealth } from "../types/database";
import { RoutingError } from "../utils/errors";
import { nowIso, timed } from "../utils/helpers";
import { logger } from "../utils/logger";
import { SimulatedClient } from "./simulated-driver";

interface ManagedNode {
  node: DatabaseNode;
  pool: Pool | null;
  simulated: SimulatedClient | null;
  healthy: boolean;
  lagMs: number | null;
}

const nodes = new Map<string, ManagedNode>();
let replicaCursor = 0;

const init = (): void => {
  if (nodes.size) return;
  for (const node of databaseConfig.nodes) {
    nodes.set(node.id, {
      node,
      pool: databaseConfig.simulate
        ? null
        : new Pool({
            connectionString: node.connectionString,
            ssl: node.connectionString.includes("ssl") || node.connectionString.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
            max: node.maxConnections,
            statement_timeout: databaseConfig.statementTimeoutMs,
          }),
      simulated: databaseConfig.simulate ? new SimulatedClient(node) : null,
      healthy: true,
      lagMs: node.role === "replica" ? 0 : null,
    });
  }
  logger.info("Pool manager initialised", {
    simulate: databaseConfig.simulate,
    nodes: [...nodes.keys()],
  });
};

export const getNodes = (): DatabaseNode[] => {
  init();
  return [...nodes.values()].map((n) => n.node);
};

/** Register a new node at runtime (Settings → Add node). */
export const addNode = (node: DatabaseNode): void => {
  init();
  nodes.set(node.id, {
    node,
    pool: databaseConfig.simulate ? null : new Pool({ connectionString: node.connectionString, ssl: node.connectionString.includes("ssl") || node.connectionString.includes("neon.tech") ? { rejectUnauthorized: false } : undefined, max: node.maxConnections, statement_timeout: databaseConfig.statementTimeoutMs }),
    simulated: databaseConfig.simulate ? new SimulatedClient(node) : null,
    healthy: true,
    lagMs: node.role === "replica" ? 0 : null,
  });
  logger.info("Node added", { nodeId: node.id });
};

/** Remove a replica at runtime; the primary cannot be removed. */
export const removeNode = async (nodeId: string): Promise<boolean> => {
  init();
  const managed = nodes.get(nodeId);
  if (!managed || managed.node.role === "primary") return false;
  nodes.delete(nodeId);
  await managed.pool?.end().catch(() => undefined);
  return true;
};

export const getPrimary = (): ManagedNode => {
  init();
  const primary = [...nodes.values()].find((n) => n.node.role === "primary");
  if (!primary) throw new RoutingError("No primary node configured");
  return primary;
};

export const getHealthyReplicas = (): DatabaseNode[] => {
  init();
  return [...nodes.values()]
    .filter(
      (n) =>
        n.node.role === "replica" &&
        n.healthy &&
        (n.lagMs === null || n.lagMs <= databaseConfig.lagThresholdMs),
    )
    .map((n) => n.node);
};

/** Round-robin selection across healthy, non-stale replicas. */
export const getReplica = (): DatabaseNode | null => {
  const available = getHealthyReplicas();
  if (!available.length) return null;
  replicaCursor = (replicaCursor + 1) % available.length;
  return available[replicaCursor];
};

export const getPoolForQuery = (target: "primary" | "replica"): DatabaseNode => {
  if (target === "replica") {
    const replica = getReplica();
    if (replica) return replica;
    logger.warn("No healthy replica available — falling back to primary");
  }
  return getPrimary().node;
};

export interface RawResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  fields: string[];
  durationMs: number;
}

export const runOnNode = async (
  nodeId: string,
  sql: string,
  params: unknown[] = [],
  tables: string[] = [],
): Promise<RawResult> => {
  init();
  const managed = nodes.get(nodeId);
  if (!managed) throw new RoutingError(`Unknown database node: ${nodeId}`);

  const { result, durationMs } = await timed(async () => {
    if (managed.simulated) return managed.simulated.query(sql, tables);
    const res = await managed.pool!.query(sql, params as never[]);
    return {
      rows: res.rows as Array<Record<string, unknown>>,
      rowCount: res.rowCount ?? res.rows.length,
      fields: res.fields?.map((f) => f.name) ?? [],
    };
  });

  return { ...result, durationMs };
};

export const checkHealth = async (nodeId: string): Promise<NodeHealth> => {
  init();
  const managed = nodes.get(nodeId);
  if (!managed) throw new RoutingError(`Unknown database node: ${nodeId}`);

  try {
    const { durationMs } = await timed(async () => {
      if (managed.simulated) return managed.simulated.query("SELECT 1", []);
      return managed.pool!.query("SELECT 1");
    });

    const lagMs =
      managed.node.role === "replica"
        ? managed.simulated
          ? await managed.simulated.replicationLagMs()
          : managed.lagMs
        : null;

    managed.healthy = true;
    managed.lagMs = lagMs;

    return {
      nodeId,
      role: managed.node.role,
      healthy: true,
      responseTimeMs: durationMs,
      replicationLagMs: lagMs,
      activeConnections: managed.pool?.totalCount ?? 1,
      lastCheckedAt: nowIso(),
    };
  } catch (error) {
    managed.healthy = false;
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Health check failed", { nodeId, error: message });
    return {
      nodeId,
      role: managed.node.role,
      healthy: false,
      responseTimeMs: -1,
      replicationLagMs: null,
      activeConnections: 0,
      lastCheckedAt: nowIso(),
      error: message,
    };
  }
};

export const setNodeHealth = (nodeId: string, healthy: boolean, lagMs: number | null): void => {
  init();
  const managed = nodes.get(nodeId);
  if (!managed) return;
  managed.healthy = healthy;
  if (managed.node.role === "replica") managed.lagMs = lagMs;
};

export const getPoolStats = (): ConnectionPoolStats[] => {
  init();
  return [...nodes.values()].map(({ node, pool }) => ({
    nodeId: node.id,
    total: pool?.totalCount ?? node.maxConnections,
    idle: pool?.idleCount ?? node.maxConnections,
    waiting: pool?.waitingCount ?? 0,
  }));
};

export const shutdownPools = async (): Promise<void> => {
  await Promise.all([...nodes.values()].map((n) => n.pool?.end()));
  nodes.clear();
};
