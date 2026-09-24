/**
 * DeepSeek AWS Bedrock Query Safety & Vector Anomaly Evaluator.
 *
 * Uses AWS Bedrock Runtime (Converse API) with DeepSeek (e.g. deepseek.v3.2)
 * to evaluate whether queries are safe for the database:
 *   - Detects SQL injection, catastrophic operations (DROP, TRUNCATE, unindexed DELETE/UPDATE)
 *   - Evaluates vector embeddings & semantic distance against safe baseline patterns
 *   - Results are cached in Redis (24-hour TTL) for high-performance sub-millisecond retrieval
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { getCache, redisKeys } from "../config/redis";
import { sha1 } from "../utils/helpers";
import { logger } from "../utils/logger";

export interface QuerySafetyResult {
  isSafe: boolean;
  riskScore: number; // 0.0 (safest) to 1.0 (most dangerous)
  riskLevel: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reasons: string[];
  suggestions: string[];
  vectorAnomaly?: {
    similarityScore: number;
    isAnomalous: boolean;
  };
  evaluatedBy: "deepseek-bedrock" | "cached" | "heuristic-fallback";
  evaluatedAt: string;
}

// AWS Bedrock client configuration
const region = process.env.AWS_REGION || "us-east-1";
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const modelId = process.env.BEDROCK_MODEL_ID || "deepseek.v3.2";

let bedrockClient: BedrockRuntimeClient | null = null;

export const isBedrockConfigured = (): boolean =>
  Boolean(accessKeyId && secretAccessKey);

const getBedrockClient = (): BedrockRuntimeClient | null => {
  if (!isBedrockConfigured()) return null;
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({
      region,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    });
  }
  return bedrockClient;
};

/**
 * Evaluates whether an SQL statement is safe for the PostgreSQL database
 * using DeepSeek via AWS Bedrock, coupled with vector embedding similarity context.
 */
export const evaluateQuerySafety = async (
  sql: string,
  vectorContext?: { similarityScore: number; isAnomalous: boolean },
): Promise<QuerySafetyResult> => {
  const trimmed = sql.trim();
  const cache = getCache();
  const cacheKey = `ai:safety:${sha1(trimmed)}`;

  // 1. Fast path: check Redis cache (24h TTL)
  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as QuerySafetyResult;
      return { ...parsed, evaluatedBy: "cached" };
    }
  } catch (err) {
    logger.warn("Redis safety cache read failed", { error: (err as Error).message });
  }

  // 2. Pre-check basic AST/heuristic safety
  const heuristicReasons: string[] = [];
  let heuristicRisk = 0;

  if (/;\s*drop\s+(table|database|schema)/i.test(trimmed)) {
    heuristicReasons.push("Destructive DROP statement detected in chain");
    heuristicRisk = Math.max(heuristicRisk, 0.95);
  }
  if (/;\s*truncate\s+/i.test(trimmed)) {
    heuristicReasons.push("TRUNCATE statement detected in chain");
    heuristicRisk = Math.max(heuristicRisk, 0.9);
  }
  if (/delete\s+from\s+[^\s]+\s*(?:;|$)/i.test(trimmed)) {
    heuristicReasons.push("DELETE statement without WHERE clause will purge entire table");
    heuristicRisk = Math.max(heuristicRisk, 0.85);
  }
  if (/update\s+[^\s]+\s+set\s+[^;]+(?:;|$)/i.test(trimmed) && !/where/i.test(trimmed)) {
    heuristicReasons.push("UPDATE statement without WHERE clause modifies all rows");
    heuristicRisk = Math.max(heuristicRisk, 0.8);
  }
  if (/\bor\s+1\s*=\s*1\b/i.test(trimmed)) {
    heuristicReasons.push("Tautology injection pattern detected (OR 1=1)");
    heuristicRisk = Math.max(heuristicRisk, 0.95);
  }
  if (/pg_sleep\s*\(/i.test(trimmed)) {
    heuristicReasons.push("Time-based SQL injection attempt (pg_sleep)");
    heuristicRisk = Math.max(heuristicRisk, 0.9);
  }

  // If vector embedding shows anomalous deviation, add to context
  if (vectorContext?.isAnomalous) {
    heuristicReasons.push(
      `Vector embedding anomaly: Semantic similarity (${vectorContext.similarityScore.toFixed(2)}) is unusually distant from known query patterns.`,
    );
    heuristicRisk = Math.max(heuristicRisk, 0.6);
  }

  const client = getBedrockClient();

  // If Bedrock is not configured, return heuristic result
  if (!client) {
    const result: QuerySafetyResult = {
      isSafe: heuristicRisk < 0.7,
      riskScore: heuristicRisk,
      riskLevel:
        heuristicRisk >= 0.85
          ? "CRITICAL"
          : heuristicRisk >= 0.7
          ? "HIGH"
          : heuristicRisk >= 0.4
          ? "MEDIUM"
          : heuristicRisk > 0
          ? "LOW"
          : "SAFE",
      reasons: heuristicReasons.length ? heuristicReasons : ["Query passed heuristic security checks."],
      suggestions: heuristicRisk > 0 ? ["Use parameterized queries or add WHERE clauses to restrict affected rows."] : [],
      vectorAnomaly: vectorContext,
      evaluatedBy: "heuristic-fallback",
      evaluatedAt: new Date().toISOString(),
    };
    return result;
  }

  // 3. DeepSeek Bedrock Evaluation
  try {
    const prompt = `You are a Principal Database Security and Performance Engineer evaluating PostgreSQL queries.
Analyze the following SQL query and vector embedding anomaly context for database safety, injection vulnerability, catastrophic data loss, and runaway CPU/memory exhaustion.

SQL Query:
\`\`\`sql
${trimmed}
\`\`\`

Vector Embedding Context:
- Semantic similarity to safe historical queries: ${vectorContext ? vectorContext.similarityScore.toFixed(2) : "N/A"}
- Anomalous vector shape: ${vectorContext?.isAnomalous ? "YES" : "NO"}
- Heuristic flags: ${heuristicReasons.length ? heuristicReasons.join("; ") : "None"}

You MUST reply with ONLY a single valid JSON object with this exact structure:
{
  "isSafe": boolean,
  "riskScore": number between 0.0 and 1.0,
  "riskLevel": "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "reasons": string[],
  "suggestions": string[]
}`;

    const command = new ConverseCommand({
      modelId,
      messages: [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
      inferenceConfig: {
        maxTokens: 512,
        temperature: 0.1,
      },
    });

    const response = await client.send(command);
    const content = response.output?.message?.content?.[0]?.text;

    if (!content) {
      throw new Error("Empty response from DeepSeek Bedrock");
    }

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not parse JSON from DeepSeek response: " + content);
    }

    const aiParsed = JSON.parse(jsonMatch[0]);

    const result: QuerySafetyResult = {
      isSafe: typeof aiParsed.isSafe === "boolean" ? aiParsed.isSafe : heuristicRisk < 0.7,
      riskScore: typeof aiParsed.riskScore === "number" ? Math.min(1, Math.max(0, aiParsed.riskScore)) : heuristicRisk,
      riskLevel: ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(aiParsed.riskLevel)
        ? aiParsed.riskLevel
        : heuristicRisk >= 0.7
        ? "HIGH"
        : "SAFE",
      reasons: Array.isArray(aiParsed.reasons) && aiParsed.reasons.length ? aiParsed.reasons : heuristicReasons,
      suggestions: Array.isArray(aiParsed.suggestions) ? aiParsed.suggestions : [],
      vectorAnomaly: vectorContext,
      evaluatedBy: "deepseek-bedrock",
      evaluatedAt: new Date().toISOString(),
    };

    // Cache the evaluation in Redis for 24 hours (86400 seconds)
    void cache.set(cacheKey, JSON.stringify(result), 86_400);

    return result;
  } catch (error) {
    logger.error("DeepSeek Bedrock safety check failed, falling back to heuristics", {
      error: (error as Error).message,
    });

    const fallbackResult: QuerySafetyResult = {
      isSafe: heuristicRisk < 0.7,
      riskScore: heuristicRisk,
      riskLevel:
        heuristicRisk >= 0.85
          ? "CRITICAL"
          : heuristicRisk >= 0.7
          ? "HIGH"
          : heuristicRisk >= 0.4
          ? "MEDIUM"
          : heuristicRisk > 0
          ? "LOW"
          : "SAFE",
      reasons: heuristicReasons.length
        ? heuristicReasons
        : ["Query passed baseline safety checks (DeepSeek fallback active)."],
      suggestions: heuristicRisk > 0 ? ["Ensure queries are parameterized and scoped with WHERE conditions."] : [],
      vectorAnomaly: vectorContext,
      evaluatedBy: "heuristic-fallback",
      evaluatedAt: new Date().toISOString(),
    };

    return fallbackResult;
  }
};
