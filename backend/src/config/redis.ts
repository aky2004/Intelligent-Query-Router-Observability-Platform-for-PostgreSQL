import Redis from "ioredis";
import { logger } from "../utils/logger";

/**
 * Redis is optional. When REDIS_URL is not set (or the connection fails) the
 * app degrades to an in-memory store with the same narrow interface, so local
 * development and tests need no Redis server.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  lpush(key: string, value: string): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  hset(key: string, field: string, value: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  incr(key: string): Promise<number>;
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
}

class RedisStore implements CacheStore {
  constructor(private client: Redis) {}
  get = (key: string) => this.client.get(key);
  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds) await this.client.set(key, value, "EX", ttlSeconds);
    else await this.client.set(key, value);
  }
  async del(key: string) {
    await this.client.del(key);
  }
  async lpush(key: string, value: string) {
    await this.client.lpush(key, value);
  }
  async ltrim(key: string, start: number, stop: number) {
    await this.client.ltrim(key, start, stop);
  }
  lrange = (key: string, start: number, stop: number) => this.client.lrange(key, start, stop);
  async hset(key: string, field: string, value: string) {
    await this.client.hset(key, field, value);
  }
  hgetall = (key: string) => this.client.hgetall(key);
  incr = (key: string) => this.client.incr(key);
}

let store: CacheStore | null = null;

export const getCache = (): CacheStore => {
  if (store) return store;
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn("REDIS_URL not set — using in-memory cache store");
    store = new MemoryStore();
    return store;
  }
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  client.on("error", (err) => logger.error("Redis error", { error: err.message }));
  store = new RedisStore(client);
  return store;
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
};
