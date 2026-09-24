import { appConfig } from "../config/app";
import { getCache, redisKeys } from "../config/redis";
import { bus } from "../events";
import { checkHealth, getNodes, setNodeHealth } from "../router/pool-manager";
import type { NodeHealth } from "../types/database";
import { logger } from "../utils/logger";
import { getReplicationLag } from "./lag-monitor";

let timer: ReturnType<typeof setInterval> | null = null;
let latest: NodeHealth[] = [];

export const checkPrimary = (): Promise<NodeHealth> => checkHealth("primary");

export const checkReplica = (nodeId: string): Promise<NodeHealth> => checkHealth(nodeId);

export const runHealthCheck = async (): Promise<NodeHealth[]> => {
  const nodes = getNodes();
  const lags = await getReplicationLag();
  const results = await Promise.all(nodes.map((node) => checkHealth(node.id)));

  const merged = results.map((health) => {
    const lag = lags.find((l) => l.nodeId === health.nodeId);
    const lagMs = lag?.lagMs ?? health.replicationLagMs;
    const healthy = health.healthy && !(lag?.stale ?? false);
    setNodeHealth(health.nodeId, healthy, lagMs ?? null);
    return { ...health, healthy, replicationLagMs: lagMs ?? null };
  });

  latest = merged;
  await getCache().set(redisKeys.nodeHealth, JSON.stringify(merged), 30);
  bus.emitEvent("health:updated", merged);
  return merged;
};

export const getHealthyReplicaHealth = (): NodeHealth[] =>
  latest.filter((n) => n.role === "replica" && n.healthy);

export const getLatestHealth = (): NodeHealth[] => latest;

export const startHealthChecks = (intervalMs = appConfig.thresholds.healthCheckIntervalMs): void => {
  if (timer) return;
  void runHealthCheck();
  timer = setInterval(() => {
    void runHealthCheck().catch((error) =>
      logger.error("Health check cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, intervalMs);
  logger.info("Health checker started", { intervalMs });
};

export const stopHealthChecks = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
