import type { Redis } from "ioredis";
import type { CacheClient } from "./cache-extension";

/**
 * Adapter to use an `ioredis` instance as a `CacheClient`.
 *
 * Consumers are responsible for creating and managing the lifecycle of the
 * underlying Redis connection.
 */
export function createRedisCacheClient(redis: Redis): CacheClient {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    },

    async set<T = unknown>(
      key: string,
      value: T,
      options?: { ttlMs?: number },
    ): Promise<void> {
      const payload = JSON.stringify(value);
      if (options?.ttlMs && options.ttlMs > 0) {
        await redis.set(key, payload, "PX", options.ttlMs);
      } else {
        await redis.set(key, payload);
      }
    },

    async del(key: string): Promise<void> {
      await redis.del(key);
    },

    async smembers(key: string): Promise<string[]> {
      return redis.smembers(key);
    },

    async sadd(
      key: string,
      member: string,
      options?: { ttlMs?: number },
    ): Promise<void> {
      await redis.sadd(key, member);
      if (options?.ttlMs && options.ttlMs > 0) {
        await redis.pexpire(key, options.ttlMs);
      }
    },
  };
}

