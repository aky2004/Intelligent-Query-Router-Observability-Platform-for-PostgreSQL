import { createHash, randomUUID } from "crypto";

export const uuid = (): string => randomUUID();

export const nowIso = (): string => new Date().toISOString();

export const sha1 = (value: string): string => createHash("sha1").update(value).digest("hex");

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  return { result, durationMs: Math.round(durationMs * 100) / 100 };
}

export const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
};

export const average = (values: number[]): number =>
  values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : 0;

export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;

export const cosineSimilarity = (a: number[], b: number[]): number => {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
};

export const safeJsonParse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/** fetch with a hard timeout — used for all outbound AI calls. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
