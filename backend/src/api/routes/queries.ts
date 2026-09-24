import { Router } from "express";
import { executeQuery, getQueryHistory, getQueryStats, routeQuery } from "../../router/query-router";
import { parseWith, querySchema } from "../../utils/validators";
import { ok } from "../response";

export const queriesRouter = Router();

/** POST /api/query — route and execute a single statement. */
queriesRouter.post("/query", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const body = parseWith(querySchema, req.body);
    const { result, decision } = await executeQuery(body.sql, body.params ?? [], {
      sessionId: body.sessionId,
      forcePrimary: body.forcePrimary,
    });
    ok(res, { result, decision }, startedAt);
  } catch (error) {
    next(error);
  }
});

/** POST /api/query/explain — routing decision only, nothing executed. */
queriesRouter.post("/query/explain", (req, res, next) => {
  const startedAt = Date.now();
  try {
    const body = parseWith(querySchema, req.body);
    ok(res, routeQuery(body.sql, { sessionId: body.sessionId, forcePrimary: body.forcePrimary }), startedAt);
  } catch (error) {
    next(error);
  }
});

/** GET /api/queries — recent query history plus routing stats. */
queriesRouter.get("/queries", (req, res, next) => {
  const startedAt = Date.now();
  try {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    ok(res, { history: getQueryHistory(limit), stats: getQueryStats() }, startedAt);
  } catch (error) {
    next(error);
  }
});
