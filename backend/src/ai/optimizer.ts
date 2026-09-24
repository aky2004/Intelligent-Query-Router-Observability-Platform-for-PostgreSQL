import { aiConfig, aiEnabled } from "../config/ai";
import { getCache, redisKeys } from "../config/redis";
import { parseQuery } from "../router/parser";
import type { IndexRecommendation, OptimizationSuggestion } from "../types/ai";
import { AIError } from "../utils/errors";
import { nowIso, safeJsonParse, sha1 } from "../utils/helpers";
import { logger } from "../utils/logger";
import { extractJson, generateText } from "./gemini-client";

export interface AnalyzeInput {
  sql: string;
  executionTimeMs?: number;
  explainPlan?: string;
}

const SYSTEM_INSTRUCTION = `You are a PostgreSQL performance engineer.
Return ONLY JSON matching:
{"summary":string,"severity":"info"|"warning"|"critical","indexes":[{"table":string,"columns":[string],"statement":string,"rationale":string}],"rewrite":string,"warnings":[string]}
Prefer concrete CREATE INDEX statements. Set "rewrite" to "" when the query is already optimal.`;

interface GeminiSuggestion {
  summary: string;
  severity?: "info" | "warning" | "critical";
  indexes?: IndexRecommendation[];
  rewrite?: string;
  warnings?: string[];
}

export const analyzeQuery = async (input: AnalyzeInput): Promise<OptimizationSuggestion> => {
  const cache = getCache();
  const key = redisKeys.optimizerCache(sha1(`${input.sql}|${input.explainPlan ?? ""}`));

  const cached = safeJsonParse<OptimizationSuggestion | null>(await cache.get(key), null);
  if (cached) return { ...cached, cached: true };

  const suggestion = aiEnabled.gemini() ? await askGemini(input) : heuristicSuggestion(input);
  await cache.set(key, JSON.stringify(suggestion), aiConfig.cacheTtlSeconds);
  return suggestion;
};

const askGemini = async (input: AnalyzeInput): Promise<OptimizationSuggestion> => {
  const parsed = parseQuery(input.sql);
  const prompt = [
    `SQL:\n${input.sql}`,
    input.executionTimeMs !== undefined ? `Execution time: ${input.executionTimeMs} ms` : "",
    input.explainPlan ? `EXPLAIN plan:\n${input.explainPlan}` : "",
    `Tables: ${parsed.tables.join(", ") || "unknown"}`,
    `Complexity score: ${parsed.complexity}/100`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const text = await generateText(prompt, SYSTEM_INSTRUCTION);
    const parsedJson = extractJson<GeminiSuggestion>(text);
    return {
      sql: input.sql,
      summary: parsedJson.summary ?? "No summary returned",
      severity: parsedJson.severity ?? "info",
      indexes: parsedJson.indexes ?? [],
      rewrite: parsedJson.rewrite?.trim() || undefined,
      warnings: parsedJson.warnings ?? [],
      cached: false,
      generatedAt: nowIso(),
    };
  } catch (error) {
    logger.warn("Gemini optimization failed — falling back to heuristics", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof AIError) return heuristicSuggestion(input);
    throw error;
  }
};

/** Deterministic rule-based analysis used when Gemini is unavailable. */
const heuristicSuggestion = (input: AnalyzeInput): OptimizationSuggestion => {
  const parsed = parseQuery(input.sql);
  const lower = input.sql.toLowerCase();
  const warnings: string[] = [];
  const indexes: IndexRecommendation[] = [];

  if (/select\s+\*/.test(lower)) warnings.push("SELECT * fetches unused columns — list them explicitly.");
  if (!/\blimit\b/.test(lower) && parsed.type === "SELECT")
    warnings.push("No LIMIT clause — unbounded result sets can exhaust memory.");
  if (/\blike\s+'%/.test(lower))
    warnings.push("Leading-wildcard LIKE cannot use a B-tree index; consider pg_trgm.");
  if (/\bor\b/.test(lower)) warnings.push("OR predicates often defeat index usage; consider UNION ALL.");
  if (/seq scan/i.test(input.explainPlan ?? "")) warnings.push("Plan contains a sequential scan.");

  for (const table of parsed.tables) {
    const where = input.sql.match(
      new RegExp(`where[\\s\\S]*?([a-z_][\\w]*)\\s*(=|>|<|in|between)`, "i"),
    );
    if (where?.[1]) {
      indexes.push({
        table,
        columns: [where[1]],
        statement: `CREATE INDEX IF NOT EXISTS idx_${table}_${where[1]} ON ${table} (${where[1]});`,
        rationale: `Predicate on ${where[1]} is a good index candidate for ${table}.`,
      });
    }
  }

  const severity =
    (input.executionTimeMs ?? 0) > 1000 ? "critical" : (input.executionTimeMs ?? 0) > 200 ? "warning" : "info";

  return {
    sql: input.sql,
    summary: `Heuristic analysis: complexity ${parsed.complexity}/100 across ${parsed.tables.length} table(s).`,
    severity,
    indexes,
    rewrite: /select\s+\*/.test(lower)
      ? input.sql.replace(/select\s+\*/i, "SELECT /* list needed columns */ *")
      : undefined,
    warnings,
    cached: false,
    generatedAt: nowIso(),
  };
};

export const suggestIndexes = async (sql: string, explainPlan?: string): Promise<IndexRecommendation[]> =>
  (await analyzeQuery({ sql, explainPlan })).indexes;

export const rewriteQuery = async (sql: string): Promise<string | undefined> =>
  (await analyzeQuery({ sql })).rewrite;
