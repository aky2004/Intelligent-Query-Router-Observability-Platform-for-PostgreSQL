import { aiConfig, aiEnabled, breakers, limiters } from "../config/ai";
import { AIError } from "../utils/errors";
import { fetchWithTimeout, sha1 } from "../utils/helpers";
import { logger } from "../utils/logger";

const EMBEDDING_DIMS = 128;

/** Deterministic local fallback embedding so anomaly detection still works keyless. */
export const hashEmbedding = (text: string): number[] => {
  const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
  const tokens = text.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const digest = sha1(token);
    for (let i = 0; i < 8; i += 1) {
      const slot = parseInt(digest.slice(i * 4, i * 4 + 4), 16) % EMBEDDING_DIMS;
      vector[slot] += 1;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / magnitude);
};

const flatten = (value: unknown): number[] => {
  if (Array.isArray(value) && typeof value[0] === "number") return value as number[];
  if (Array.isArray(value) && Array.isArray(value[0])) {
    const rows = value as number[][];
    const dims = rows[0].length;
    const mean = new Array<number>(dims).fill(0);
    for (const row of rows) row.forEach((v, i) => (mean[i] += v / rows.length));
    return mean;
  }
  throw new AIError("Unexpected embedding response shape");
};

export const embed = async (text: string): Promise<{ vector: number[]; source: "huggingface" | "local" }> => {
  if (!aiEnabled.huggingFace() || breakers.huggingFace.open || !limiters.huggingFace.allow()) {
    return { vector: hashEmbedding(text), source: "local" };
  }

  const url = `${aiConfig.huggingFace.baseUrl}/pipeline/feature-extraction/${aiConfig.huggingFace.embeddingModel}`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aiConfig.huggingFace.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
      },
      aiConfig.requestTimeoutMs,
    );

    if (!response.ok) {
      breakers.huggingFace.failure();
      logger.warn("Hugging Face embedding failed — using local fallback", { status: response.status });
      return { vector: hashEmbedding(text), source: "local" };
    }

    const payload = (await response.json()) as unknown;
    breakers.huggingFace.success();
    return { vector: flatten(payload), source: "huggingface" };
  } catch (error) {
    breakers.huggingFace.failure();
    logger.warn("Hugging Face embedding error — using local fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { vector: hashEmbedding(text), source: "local" };
  }
};
