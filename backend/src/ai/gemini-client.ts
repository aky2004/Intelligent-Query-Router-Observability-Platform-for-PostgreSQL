import { aiConfig, aiEnabled, breakers, limiters } from "../config/ai";
import { AIError } from "../utils/errors";
import { fetchWithTimeout } from "../utils/helpers";
import { logger } from "../utils/logger";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

/** Single entry point for all Gemini calls: rate limited + circuit broken. */
export const generateText = async (prompt: string, systemInstruction?: string): Promise<string> => {
  if (!aiEnabled.gemini()) throw new AIError("GEMINI_API_KEY is not configured");
  if (breakers.gemini.open) throw new AIError("Gemini circuit breaker is open — try again shortly");
  if (!limiters.gemini.allow()) throw new AIError("Gemini rate limit exceeded", { retryable: true });

  const url = `${aiConfig.gemini.baseUrl}/models/${aiConfig.gemini.model}:generateContent?key=${aiConfig.gemini.apiKey}`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      },
      aiConfig.requestTimeoutMs,
    );

    const payload = (await response.json()) as GeminiResponse;
    if (!response.ok) {
      breakers.gemini.failure();
      throw new AIError(payload.error?.message ?? `Gemini request failed (${response.status})`, {
        status: response.status,
      });
    }

    const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) {
      breakers.gemini.failure();
      throw new AIError("Gemini returned an empty response");
    }

    breakers.gemini.success();
    return text;
  } catch (error) {
    if (error instanceof AIError) throw error;
    breakers.gemini.failure();
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Gemini call failed", { error: message });
    throw new AIError(`Gemini call failed: ${message}`);
  }
};

/** Extracts the first JSON object from a model response, tolerating code fences. */
export const extractJson = <T>(text: string): T => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new AIError("Model response contained no JSON object");
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    throw new AIError("Model response contained malformed JSON");
  }
};
