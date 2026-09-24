import type { Response } from "express";
import { uuid } from "../utils/helpers";

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: { timestamp: string; requestId: string; duration: number };
}

export const ok = <T>(res: Response, data: T, startedAt = Date.now()): Response =>
  res.json({
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      requestId: (res.getHeader("x-request-id") as string) ?? uuid(),
      duration: Date.now() - startedAt,
    },
  } satisfies ApiResponse<T>);

export const fail = (
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response =>
  res.status(status).json({
    success: false,
    error: { code, message, details },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: (res.getHeader("x-request-id") as string) ?? uuid(),
      duration: 0,
    },
  } satisfies ApiResponse<never>);
