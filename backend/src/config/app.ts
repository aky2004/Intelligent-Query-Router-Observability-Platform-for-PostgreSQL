import dotenv from "dotenv";

dotenv.config();

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const appConfig = {
  env: process.env.NODE_ENV ?? "development",
  port: num(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 100),
  thresholds: {
    slowQueryMs: num(process.env.SLOW_QUERY_THRESHOLD_MS, 100),
    replicaLagMs: num(process.env.REPLICA_LAG_THRESHOLD_MS, 1000),
    anomalyWindow: num(process.env.ANOMALY_DETECTION_WINDOW, 1000),
    healthCheckIntervalMs: num(process.env.HEALTH_CHECK_INTERVAL_MS, 5000),
  },
  captureDir: process.env.CAPTURE_DIR ?? "./captures",
} as const;

export type AppConfig = typeof appConfig;
