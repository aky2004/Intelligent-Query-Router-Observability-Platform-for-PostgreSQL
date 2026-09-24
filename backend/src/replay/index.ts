export { startCapture, stopCapture, writeQuery, getCaptureStatus, listCaptureFiles } from "./capture";
export { replayQueries, compareResults, getReplayStats } from "./replay";
export type { CapturedQuery } from "./capture";
export type { ReplayStats, ReplaySpeed, ReplayComparison } from "./replay";
