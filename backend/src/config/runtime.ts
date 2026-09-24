import { appConfig } from "./app";

/** Mutable runtime settings, editable from the dashboard's Settings page. */
export const runtimeSettings = {
  thresholds: {
    slowQueryMs: appConfig.thresholds.slowQueryMs,
    replicaLagMs: appConfig.thresholds.replicaLagMs,
    anomalyDetectionWindow: appConfig.thresholds.anomalyWindow,
  },
  ai: {
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    embeddingModel: process.env.EMBEDDING_MODEL ?? "all-MiniLM-L6-v2",
  },
  liveUpdates: true,
};
