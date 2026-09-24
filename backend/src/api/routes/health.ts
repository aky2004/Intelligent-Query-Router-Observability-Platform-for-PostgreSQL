import { Router } from "express";
import { aiEnabled } from "../../config/ai";
import { databaseConfig } from "../../config/database";
import { getLatestHealth, runHealthCheck } from "../../monitors/health-checker";
import { getReplicationLag } from "../../monitors/lag-monitor";
import { getNodes, getPoolStats } from "../../router/pool-manager";
import { activeTransactions } from "../../router/transaction-state";
import { ok } from "../response";

export const healthRouter = Router();

/** GET /api/health — overall system status. */
healthRouter.get("/health", async (_req, res, next) => {
  const startedAt = Date.now();
  try {
    const nodes = getLatestHealth().length ? getLatestHealth() : await runHealthCheck();
    const healthy = nodes.every((n) => n.healthy);
    ok(
      res,
      {
        status: healthy ? "healthy" : "degraded",
        simulated: databaseConfig.simulate,
        ai: { gemini: aiEnabled.gemini(), huggingFace: aiEnabled.huggingFace() },
        nodes,
        activeTransactions: activeTransactions().length,
        uptimeSeconds: Math.round(process.uptime()),
      },
      startedAt,
    );
  } catch (error) {
    next(error);
  }
});

/** GET /api/nodes — configured database nodes with pool and lag detail. */
healthRouter.get("/nodes", async (_req, res, next) => {
  const startedAt = Date.now();
  try {
    ok(
      res,
      { nodes: getNodes(), pools: getPoolStats(), lag: await getReplicationLag() },
      startedAt,
    );
  } catch (error) {
    next(error);
  }
});
