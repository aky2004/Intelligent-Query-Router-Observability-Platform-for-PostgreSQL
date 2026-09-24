import { z } from "zod";
import { ValidationError } from "./errors";

export const MAX_SQL_LENGTH = 20_000;

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /;\s*drop\s+(table|database|schema)/i, message: "Chained DROP statement detected" },
  { pattern: /;\s*truncate\s+/i, message: "Chained TRUNCATE statement detected" },
  { pattern: /\bor\s+1\s*=\s*1\b/i, message: "Classic tautology injection pattern detected" },
  { pattern: /\bunion\s+all\s+select\b.*\bfrom\s+pg_/i, message: "Catalog probing via UNION detected" },
  { pattern: /pg_sleep\s*\(/i, message: "pg_sleep() time-based injection detected" },
  { pattern: /\bcopy\b.*\bfrom\s+program\b/i, message: "COPY FROM PROGRAM is not allowed" },
  { pattern: /--.*;\s*\w/i, message: "Comment-terminated statement stacking detected" },
];

export const querySchema = z.object({
  sql: z.string().min(1).max(MAX_SQL_LENGTH),
  params: z.array(z.unknown()).max(100).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  forcePrimary: z.boolean().optional(),
});

export const optimizeSchema = z.object({
  sql: z.string().min(1).max(MAX_SQL_LENGTH),
  executionTimeMs: z.number().nonnegative().optional(),
  explainPlan: z.string().max(50_000).optional(),
});

export const nlSchema = z.object({
  question: z.string().min(3).max(2000),
  schema: z.string().max(50_000).optional(),
});

export const replaySchema = z.object({
  file: z.string().min(1).max(512),
  speed: z.union([z.literal(0.5), z.literal(1), z.literal(2), z.literal(10)]).default(1),
  compare: z.boolean().default(false),
  limit: z.number().int().positive().max(100_000).optional(),
});

export const metricsQuerySchema = z.object({
  windowMs: z.coerce.number().int().positive().max(86_400_000).default(300_000),
  metric: z.enum(["duration", "throughput", "errors"]).default("duration"),
});

/** Statement-count / injection heuristics. Parameterized queries are still required downstream. */
export const assertSafeSql = (sql: string): void => {
  const trimmed = sql.trim();
  if (!trimmed) throw new ValidationError("SQL must not be empty");
  if (trimmed.length > MAX_SQL_LENGTH) throw new ValidationError("SQL exceeds maximum length");

  const statements = trimmed.replace(/;\s*$/, "").split(/;(?=(?:[^']*'[^']*')*[^']*$)/);
  if (statements.length > 1) {
    throw new ValidationError("Multiple statements per request are not allowed", { statements: statements.length });
  }

  for (const { pattern, message } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) throw new ValidationError(`Rejected query: ${message}`);
  }
};

export const parseWith = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError("Invalid request payload", result.error.flatten());
  }
  return result.data;
};
