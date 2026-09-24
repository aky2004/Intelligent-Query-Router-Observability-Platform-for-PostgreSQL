import { createWriteStream, existsSync, mkdirSync, readdirSync, type WriteStream } from "fs";
import path from "path";
import { appConfig } from "../config/app";
import type { ExecutedQuery } from "../types/query";
import { nowIso } from "../utils/helpers";
import { logger } from "../utils/logger";

export interface CapturedQuery {
  timestamp: string;
  offsetMs: number;
  sql: string;
  sessionId: string;
  target: "primary" | "replica";
  durationMs: number;
  rowCount: number;
}

interface CaptureState {
  active: boolean;
  stream: WriteStream | null;
  file: string | null;
  day: string | null;
  startedAt: number | null;
  written: number;
}

const state: CaptureState = {
  active: false,
  stream: null,
  file: null,
  day: null,
  startedAt: null,
  written: 0,
};

const today = (): string => new Date().toISOString().slice(0, 10);

const ensureDir = (): string => {
  const dir = path.resolve(appConfig.captureDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

const openStream = (): void => {
  const dir = ensureDir();
  const day = today();
  const file = path.join(dir, `queries-${day}.jsonl`);
  state.stream?.end();
  state.stream = createWriteStream(file, { flags: "a" });
  state.file = file;
  state.day = day;
  logger.info("Capture file opened", { file });
};

export const startCapture = (): { file: string } => {
  if (!state.active) {
    state.active = true;
    state.startedAt = Date.now();
    state.written = 0;
    openStream();
  }
  return { file: state.file! };
};

export const stopCapture = (): { file: string | null; written: number } => {
  state.active = false;
  state.stream?.end();
  state.stream = null;
  return { file: state.file, written: state.written };
};

/** Appends one query to the active capture file, rotating at midnight UTC. */
export const writeQuery = (executed: ExecutedQuery): void => {
  if (!state.active || !state.stream) return;
  if (state.day !== today()) openStream();

  const record: CapturedQuery = {
    timestamp: executed.executedAt ?? nowIso(),
    offsetMs: state.startedAt ? Date.now() - state.startedAt : 0,
    sql: executed.sql,
    sessionId: executed.sessionId,
    target: executed.decision.target,
    durationMs: executed.durationMs,
    rowCount: executed.rowCount,
  };

  state.stream.write(`${JSON.stringify(record)}\n`);
  state.written += 1;
};

export const getCaptureStatus = () => ({
  active: state.active,
  file: state.file,
  written: state.written,
  startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
});

export const listCaptureFiles = (): string[] => {
  const dir = ensureDir();
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
};
