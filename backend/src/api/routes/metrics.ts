import { Router } from "express";
import { getMetrics, getSlowQueries, getTimeSeries } from "../../monitors/metrics-collector";
import { metricsQuerySchema, parseWith } from "../../utils/validators";
import { ok } from "../response";

export const metricsRouter = Router();

/** GET /api/metrics — snapshot plus a time series for the requested metric. */
metricsRouter.get("/metrics", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const parsedQuery = parseWith(metricsQuerySchema, req.query);
    const windowMs = parsedQuery.windowMs ?? 300_000;
    const metric = parsedQuery.metric ?? "duration";
    ok(
      res,
      {
        snapshot: await getMetrics(windowMs),
        metric,
        series: await getTimeSeries(metric, windowMs),
      },
      startedAt,
    );
  } catch (error) {
    next(error);
  }
});

/** GET /api/slow-queries — slowest recent statements. */
metricsRouter.get("/slow-queries", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 200);
    ok(res, { queries: await getSlowQueries(limit) }, startedAt);
  } catch (error) {
    next(error);
  }
});
