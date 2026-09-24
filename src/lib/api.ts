// REST client for the pg-router-ai backend: retries with exponential backoff,
// friendly error messages, bearer auth, and 401 → login redirect.
import { authStore } from "@/lib/auth";

const URL_KEY = "pg-router:api-url";
const env = import.meta.env as Record<string, string | undefined>;

export function getApiUrl(): string {
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(URL_KEY);
    if (saved !== null && saved.trim() !== "") return saved;
  }
  return (env["VITE_API_URL"] ?? "").replace(/\/$/, "");
}
export function setApiUrl(url: string) {
  window.localStorage.setItem(URL_KEY, url.trim().replace(/\/$/, ""));
}
export function getSocketUrl(): string {
  const saved = typeof window !== "undefined" ? window.localStorage.getItem(URL_KEY) : null;
  return (saved ?? env["VITE_SOCKET_URL"] ?? getApiUrl()).replace(/^ws/, "http");
}
export const isBackendConfigured = () => getApiUrl().length > 0;

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

const MESSAGES = {
  network: "Cannot connect to backend. Please check your connection.",
  server: "Something went wrong. Please try again.",
  unconfigured: "No backend address configured — showing simulated data.",
};

interface Envelope<T> { success?: boolean; data?: T; error?: { code?: string; message?: string } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function api<T>(path: string, init: RequestInit & { retries?: number; json?: unknown } = {}): Promise<T> {
  const base = getApiUrl();
  if (!base) throw new ApiError(MESSAGES.unconfigured, 0, "UNCONFIGURED");
  const { retries = 3, json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  if (authStore.token) headers.set("Authorization", `Bearer ${authStore.token}`);

  let lastErr = new ApiError(MESSAGES.network, 0, "NETWORK");
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1)); // 500ms, 1s, 2s
    let res: Response;
    try {
      res = await fetch(base + path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : (rest.body ?? null), credentials: "include" });
    } catch {
      lastErr = new ApiError(MESSAGES.network, 0, "NETWORK");
      continue;
    }
    if (res.status === 401) {
      if (typeof window !== "undefined") window.location.assign("/auth?mode=login");
      throw new ApiError("Your session expired. Please sign in again.", 401, "UNAUTHORIZED");
    }
    const body = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (res.status >= 500) { lastErr = new ApiError(MESSAGES.server, res.status, "SERVER"); continue; }
    if (!res.ok || body.success === false) {
      throw new ApiError(body.error?.message ?? `Request failed (${res.status})`, res.status, body.error?.code ?? "REQUEST");
    }
    return (body.data !== undefined ? body.data : body) as T;
  }
  throw lastErr;
}

/** Upload with progress (fetch has no upload progress). */
export function uploadFile<T>(path: string, file: File, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const base = getApiUrl();
    if (!base) return reject(new ApiError(MESSAGES.unconfigured, 0, "UNCONFIGURED"));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", base + path);
    xhr.withCredentials = true;
    if (authStore.token) xhr.setRequestHeader("Authorization", `Bearer ${authStore.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100);
    xhr.onerror = () => reject(new ApiError(MESSAGES.network, 0, "NETWORK"));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as Envelope<T>;
        if (xhr.status >= 400 || body.success === false) return reject(new ApiError(body.error?.message ?? MESSAGES.server, xhr.status, "UPLOAD"));
        resolve((body.data ?? body) as T);
      } catch { reject(new ApiError(MESSAGES.server, xhr.status, "UPLOAD")); }
    };
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : MESSAGES.server);
