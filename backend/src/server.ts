import { createServer } from "http";
import { createApp, registerSocketEvents } from "./api";
import { appConfig } from "./config/app";
import { databaseConfig } from "./config/database";
import { startHealthChecks, stopHealthChecks } from "./monitors/health-checker";
import { startCapture, stopCapture } from "./replay/capture";
import { shutdownPools } from "./router/pool-manager";
import { startPgProxyServer } from "./proxy/pg-wire-server";
import { logger } from "./utils/logger";

const app = createApp();
const httpServer = createServer(app);
registerSocketEvents(httpServer);

const pgProxyPort = Number(process.env.PG_PROXY_PORT ?? 5433);
const pgProxyServer = startPgProxyServer(pgProxyPort);

httpServer.listen(appConfig.port, () => {
  logger.info("pg-router-ai HTTP listening", {
    port: appConfig.port,
    pgProxyPort,
    env: appConfig.env,
    simulatedDatabases: databaseConfig.simulate,
    nodes: databaseConfig.nodes.map((n) => n.id),
    docs: `http://localhost:${appConfig.port}/docs`,
  });
  startHealthChecks();
  startCapture();
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info("Shutting down", { signal });
  stopHealthChecks();
  stopCapture();
  pgProxyServer.close();
  httpServer.close();
  await shutdownPools();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection", { reason: String(reason) }));
