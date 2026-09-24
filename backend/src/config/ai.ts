import { logger } from "../utils/logger";

/**
 * Shared AI configuration plus a token-bucket rate limiter and circuit
 * breaker used by every AI module (optimizer, anomaly, nl-to-sql).
 */
export const aiConfig = {
  huggingFace: {
    apiKey: process.env.HUGGINGFACE_API_KEY ?? "",
    embeddingModel: process.env.HUGGINGFACE_EMBEDDING_MODEL ?? "sentence-transformers/all-MiniLM-L6-v2",
    baseUrl: "https://api-inference.huggingface.co",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  cacheTtlSeconds: 60 * 60,
  requestsPerMinute: 60,
  requestTimeoutMs: 20_000,
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000 },
} as const;

export const aiEnabled = {
  gemini: () => aiConfig.gemini.apiKey.length > 0,
  huggingFace: () => aiConfig.huggingFace.apiKey.length > 0,
};

class RateLimiter {
  private timestamps: number[] = [];
  constructor(private perMinute: number) {}
  allow(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= this.perMinute) return false;
    this.timestamps.push(now);
    return true;
  }
}

class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  constructor(private name: string) {}

  get open(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt > aiConfig.circuitBreaker.cooldownMs) {
      this.reset();
      return false;
    }
    return true;
  }

  success() {
    this.reset();
  }

  failure() {
    this.failures += 1;
    if (this.failures >= aiConfig.circuitBreaker.failureThreshold) {
      this.openedAt = Date.now();
      logger.warn("AI circuit breaker opened", { provider: this.name });
    }
  }

  private reset() {
    this.failures = 0;
    this.openedAt = null;
  }
}

export const limiters = {
  gemini: new RateLimiter(aiConfig.requestsPerMinute),
  huggingFace: new RateLimiter(aiConfig.requestsPerMinute),
};

export const breakers = {
  gemini: new CircuitBreaker("gemini"),
  huggingFace: new CircuitBreaker("huggingface"),
};
