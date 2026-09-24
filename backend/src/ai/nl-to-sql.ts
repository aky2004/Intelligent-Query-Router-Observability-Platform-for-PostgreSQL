import { aiEnabled } from "../config/ai";
import { parseQuery } from "../router/parser";
import { simulatedSchemaDescription } from "../router/simulated-driver";
import type { NLQueryResult } from "../types/ai";
import { AIError } from "../utils/errors";
import { logger } from "../utils/logger";
import { assertSafeSql } from "../utils/validators";
import { extractJson, generateText } from "./gemini-client";

const SYSTEM_INSTRUCTION = `You translate natural language questions into a single PostgreSQL statement.
Return ONLY JSON: {"sql":string,"confidence":number,"explanation":string}
Rules: one statement, no trailing semicolon issues, never DROP/TRUNCATE/ALTER, always add a LIMIT to open-ended SELECTs,
use only tables and columns present in the provided schema, and use $1-style placeholders for user-supplied values.`;

export interface ValidationOutcome {
  valid: boolean;
  errors: string[];
  routing: "primary" | "replica";
}

export const validateGeneratedSQL = (sql: string): ValidationOutcome => {
  const errors: string[] = [];
  try {
    assertSafeSql(sql);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  let routing: "primary" | "replica" = "replica";
  try {
    const parsed = parseQuery(sql);
    routing = parsed.isWrite ? "primary" : "replica";
    if (parsed.type === "UNKNOWN") errors.push("Could not determine the statement type");
    if (parsed.type === "DDL") errors.push("DDL statements are not allowed from natural language");
    if (!parsed.tables.length && parsed.type === "SELECT") errors.push("No tables referenced");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return { valid: errors.length === 0, errors, routing };
};

export const convertToSQL = async (question: string, schema?: string): Promise<NLQueryResult> => {
  if (!aiEnabled.gemini()) {
    throw new AIError("Natural language to SQL requires GEMINI_API_KEY to be configured");
  }

  const schemaContext = schema?.trim() || simulatedSchemaDescription;
  const prompt = `Schema:\n${schemaContext}\n\nQuestion: ${question}`;

  const text = await generateText(prompt, SYSTEM_INSTRUCTION);
  const parsed = extractJson<{ sql?: string; confidence?: number; explanation?: string }>(text);
  const sql = (parsed.sql ?? "").trim();

  if (!sql) throw new AIError("Model did not return SQL");

  const validation = validateGeneratedSQL(sql);
  if (!validation.valid) {
    logger.warn("Generated SQL failed validation", { errors: validation.errors });
  }

  return {
    question,
    sql,
    confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
    explanation: parsed.explanation ?? "",
    routing: validation.routing,
    valid: validation.valid,
    validationErrors: validation.errors,
  };
};
