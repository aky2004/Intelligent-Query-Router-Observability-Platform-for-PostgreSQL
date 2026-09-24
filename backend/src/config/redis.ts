import Redis from "ioredis";
import { logger } from "../utils/logger";

/**
 * Production-ready cache interface backed by Redis with automatic fallback
 * to an in-memory store if Redis is unavailable.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  delPattern(pattern: string): Promise<void>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  lpush(key: string, value: string): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  hset(key: string, field: string, value: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  incr(key: string): Promise<number>;
  isHealthy(): Promise<boolean>;
  ping(): Promise<number>;
}

class MemoryStore implements CacheStore {
  private values = new Map<string, { value: string; expiresAt: number | null }>();
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Map<string, string>>();

  async get(key: string) {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    this.values.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }

  async del(key: string) {
    this.values.delete(key);
    this.lists.delete(key);
    this.hashes.delete(key);
  }

  async delPattern(pattern: string) {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    for (const k of this.values.keys()) {
      if (regex.test(k)) this.values.delete(k);
    }
    for (const k of this.lists.keys()) {
      if (regex.test(k)) this.lists.delete(k);
    }
    for (const k of this.hashes.keys()) {
      if (regex.test(k)) this.hashes.delete(k);
    }
  }

  async expire(key: string, ttlSeconds: number) {
    const entry = this.values.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + ttlSeconds * 1000;
    }
  }

  async lpush(key: string, value: string) {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
  }

  async ltrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop + 1));
  }

  async lrange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }

  async hset(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    this.hashes.set(key, hash);
  }

  async hgetall(key: string) {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }

  async incr(key: string) {
    const next = Number((await this.get(key)) ?? 0) + 1;
    await this.set(key, String(next));
    return next;
  }

  async isHealthy() {
    return true;
  }

  async ping() {
    return 1;
  }
}

class RedisStore implements CacheStore {
  constructor(private client: Redis) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      logger.error("Redis get failed", { key, error: (err as Error).message });
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(key, value, "EX", ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch (err) {
      logger.error("Redis set failed", { key, error: (err as Error).message });
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.error("Redis del failed", { key, error: (err as Error).message });
    }
  }

  async delPattern(pattern: string): Promise<void> {
    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.client.del(...keys);
        }
      } while (cursor !== "0");
    } catch (err) {
      logger.error("Redis delPattern failed", { pattern, error: (err as Error).message });
    }
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.expire(key, ttlSeconds);
    } catch (err) {
      logger.error("Redis expire failed", { key, error: (err as Error).message });
    }
  }

  async lpush(key: string, value: string): Promise<void> {
    try {
      await this.client.lpush(key, value);
    } catch (err) {
      logger.error("Redis lpush failed", { key, error: (err as Error).message });
    }
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    try {
      await this.client.ltrim(key, start, stop);
    } catch (err) {
      logger.error("Redis ltrim failed", { key, error: (err as Error).message });
    }
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    try {
      return await this.client.lrange(key, start, stop);
    } catch (err) {
      logger.error("Redis lrange failed", { key, error: (err as Error).message });
      return [];
    }
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    try {
      await this.client.hset(key, field, value);
    } catch (err) {
      logger.error("Redis hset failed", { key, field, error: (err as Error).message });
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    try {
      return await this.client.hgetall(key);
    } catch (err) {
      logger.error("Redis hgetall failed", { key, error: (err as Error).message });
      return {};
    }
  }

  async incr(key: string): Promise<number> {
    try {
      return await this.client.incr(key);
    } catch (err) {
      logger.error("Redis incr failed", { key, error: (err as Error).message });
      return 1;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.client.ping();
      return res === "PONG";
    } catch {
      return false;
    }
  }

  async ping(): Promise<number> {
    const t0 = Date.now();
    await this.client.ping();
    return Date.now() - t0;
  }
}

let store: CacheStore | null = null;
let rawRedisClient: Redis | null = null;

export const getCache = (): CacheStore => {
  if (store) return store;
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn("REDIS_URL not set — using in-memory cache store");
    store = new MemoryStore();
    return store;
  }

  try {
    const client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 5000,
      commandTimeout: 3000,
      autoResubscribe: true,
      keepAlive: 10000,
      retryStrategy(times) {
        const delay = Math.min(times * 150, 3000);
        logger.info(`Reconnecting to Redis in ${delay}ms (attempt ${times})`);
        return delay;
      },
      reconnectOnError(err) {
        const targetError = "READONLY";
        return err.message.includes(targetError);
      },
    });

    client.on("connect", () => logger.info("Redis connected"));
    client.on("ready", () => logger.info("Redis ready to accept commands"));
    client.on("error", (err) => logger.error("Redis error", { error: err.message }));
    client.on("close", () => logger.warn("Redis connection closed"));

    rawRedisClient = client;
    store = new RedisStore(client);
    return store;
  } catch (err) {
    logger.error("Failed to initialize Redis client, falling back to MemoryStore", {
      error: (err as Error).message,
    });
    store = new MemoryStore();
    return store;
  }
};

export const getRawRedis = (): Redis | null => {
  getCache(); // ensures initialized
  return rawRedisClient;
};

export const redisKeys = {
  optimizerCache: (hash: string) => `ai:optimizer:${hash}`,
  patternHistory: "ai:patterns",
  patternHash: "ai:pattern:hash",
  queryHistory: "metrics:queries",
  slowQueries: "metrics:slow",
  timeSeries: (metric: string) => `metrics:ts:${metric}`,
  nodeHealth: "db:health",
  replicaLag: "db:lag",
  queryCache: (hash: string) => `query:cache:${hash}`,
  tableTag: (table: string) => `query:tag:${table}`,
  dashboardMetrics: "cache:metrics:dashboard",
  nodesView: "cache:nodes:view",
};
