import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { appConfig } from "../config/app";
import { isAppError } from "../utils/errors";
import { uuid } from "../utils/helpers";
import { logger } from "../utils/logger";
import { openApiDocument } from "./openapi";
import { fail } from "./response";
import { aiRouter } from "./routes/ai";
import { healthRouter } from "./routes/health";
import { metricsRouter } from "./routes/metrics";
import { queriesRouter } from "./routes/queries";
import { replayRouter } from "./routes/replay";
import { authRouter, requireAuth } from "./routes/auth";
import { dashboardRouter } from "./routes/dashboard";
import { ZodError } from "zod";

export const createApp = (): express.Express => {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: appConfig.corsOrigin, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const requestId = (req.headers["x-request-id"] as string) ?? uuid();
    res.setHeader("x-request-id", requestId);
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info("request", {
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  // 100 requests/minute per IP by default.
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: appConfig.rateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests" } },
    }),
  );

  app.use("/api", authRouter);
  app.use("/api", requireAuth, dashboardRouter); // dashboard API (takes precedence)
  app.use("/api", requireAuth, queriesRouter);
  app.use("/api", requireAuth, healthRouter);
  app.use("/api", requireAuth, metricsRouter);
  app.use("/api", requireAuth, aiRouter);
  app.use("/api", requireAuth, replayRouter);
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use((_req, res) => fail(res, 404, "NOT_FOUND", "Route not found"));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      return fail(res, 422, "VALIDATION_ERROR", "Invalid request", error.flatten());
    }
    if (isAppError(error)) {
      return fail(res, error.status, error.code, error.message, error.details);
    }
    const message = error instanceof Error ? error.message : "Unexpected error";
    logger.error("Unhandled error", { error: message });
    return fail(res, 500, "INTERNAL_ERROR", message);
  });

  return app;
};

export { registerSocketEvents, getIo } from "./socket/events";
