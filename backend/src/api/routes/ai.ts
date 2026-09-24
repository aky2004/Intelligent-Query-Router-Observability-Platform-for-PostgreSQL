import { Router } from "express";
import { getPatternHistory } from "../../ai/anomaly";
import { convertToSQL } from "../../ai/nl-to-sql";
import { analyzeQuery } from "../../ai/optimizer";
import { nlSchema, optimizeSchema, parseWith } from "../../utils/validators";
import { ok } from "../response";

export const aiRouter = Router();

/** POST /api/ai/optimize — index and rewrite suggestions for a statement. */
aiRouter.post("/ai/optimize", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const body = parseWith(optimizeSchema, req.body);
    ok(res, await analyzeQuery(body), startedAt);
  } catch (error) {
    next(error);
  }
});

/** POST /api/ai/convert — natural language to SQL with a routing decision. */
aiRouter.post("/ai/convert", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const body = parseWith(nlSchema, req.body);
    ok(res, await convertToSQL(body.question, body.schema), startedAt);
  } catch (error) {
    next(error);
  }
});

/** GET /api/ai/patterns — learned query-shape history used for anomaly scoring. */
aiRouter.get("/ai/patterns", async (_req, res, next) => {
  const startedAt = Date.now();
  try {
    const patterns = await getPatternHistory();
    ok(
      res,
      {
        count: patterns.length,
        patterns: patterns.slice(0, 50).map(({ embedding, ...rest }) => ({
          ...rest,
          embeddingDims: embedding.length,
        })),
      },
      startedAt,
    );
  } catch (error) {
    next(error);
  }
});
