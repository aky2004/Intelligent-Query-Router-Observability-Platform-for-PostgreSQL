import { Router } from "express";
import {
  getCaptureStatus,
  listCaptureFiles,
  startCapture,
  stopCapture,
} from "../../replay/capture";
import { getReplayStats, replayQueries } from "../../replay/replay";
import { parseWith, replaySchema } from "../../utils/validators";
import { ok } from "../response";

export const replayRouter = Router();

/** POST /api/replay/capture/start|stop — control production query capture. */
replayRouter.post("/replay/capture/start", (_req, res, next) => {
  const startedAt = Date.now();
  try {
    ok(res, startCapture(), startedAt);
  } catch (error) {
    next(error);
  }
});

replayRouter.post("/replay/capture/stop", (_req, res, next) => {
  const startedAt = Date.now();
  try {
    ok(res, stopCapture(), startedAt);
  } catch (error) {
    next(error);
  }
});

/** POST /api/replay/start — replay a capture file at a chosen speed. */
replayRouter.post("/replay/start", (req, res, next) => {
  const startedAt = Date.now();
  try {
    const body = parseWith(replaySchema, req.body);
    ok(res, replayQueries(body), startedAt);
  } catch (error) {
    next(error);
  }
});

/** GET /api/replay/status — capture state, available files and replay runs. */
replayRouter.get("/replay/status", (req, res, next) => {
  const startedAt = Date.now();
  try {
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    ok(
      res,
      {
        capture: getCaptureStatus(),
        files: listCaptureFiles(),
        runs: getReplayStats(runId),
      },
      startedAt,
    );
  } catch (error) {
    next(error);
  }
});
