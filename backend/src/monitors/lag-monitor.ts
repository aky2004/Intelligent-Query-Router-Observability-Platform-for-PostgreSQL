import { databaseConfig } from "../config/database";
import { getCache, redisKeys } from "../config/redis";
import { bus } from "../events";
import { getNodes, runOnNode } from "../router/pool-manager";
import { logger } from "../utils/logger";

const LAG_SQL = `
  SELECT client_addr::text AS client_addr,
         application_name,
         COALESCE(EXTRACT(EPOCH FROM replay_lag) * 1000, 0) AS lag_ms
  FROM pg_stat_replication
`;

export interface ReplicaLag {
  nodeId: string;
  lagMs: number;
  stale: boolean;
}

/** Reads pg_stat_replication on the primary (or simulates lag when SIMULATE_DB=true). */
export const getReplicationLag = async (): Promise<ReplicaLag[]> => {
  const nodes = getNodes();
  const replicas = nodes.filter((n) => n.role === "replica");
  const cache = getCache();

  if (replicas.length === 0) {
    await cache.set(redisKeys.replicaLag, JSON.stringify([]), 60);
    return [];
  }

  const hasPrimary = nodes.some((n) => n.role === "primary");
  let lagByIndex: number[] = [];

  if (databaseConfig.simulate) {
    lagByIndex = replicas.map(() => Math.round(Math.random() * 1400));
  } else if (!hasPrimary) {
    lagByIndex = replicas.map(() => 0);
  } else {
    try {
      const raw = await runOnNode("primary", LAG_SQL);
      lagByIndex = raw.rows.map((row) => Number(row.lag_ms ?? 0));
    } catch (error) {
      logger.error("Failed to read pg_stat_replication", {
        error: error instanceof Error ? error.message : String(error),
      });
      lagByIndex = replicas.map(() => 0);
    }
  }

  const results = replicas.map((replica, index) => {
    const lagMs = lagByIndex[index] ?? 0;
    const stale = lagMs > databaseConfig.lagThresholdMs;
    if (stale) {
      bus.emitEvent("lag:exceeded", {
        nodeId: replica.id,
        lagMs,
        thresholdMs: databaseConfig.lagThresholdMs,
      });
    }
    return { nodeId: replica.id, lagMs, stale };
  });

  await cache.set(redisKeys.replicaLag, JSON.stringify(results), 60);
  return results;
};

export const isReplicaStale = async (nodeId: string): Promise<boolean> => {
  const lags = await getReplicationLag();
  return lags.find((l) => l.nodeId === nodeId)?.stale ?? true;
};
