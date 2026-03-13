# prisma-redis-cache-extension

Framework-agnostic Prisma Client caching extension backed by Redis (or any compatible `CacheClient`).

## Installation

```bash
npm install prisma-redis-cache-extension
```

You must also have `@prisma/client` installed in your project.

## Quick start

```ts
import { PrismaClient, Prisma } from "@prisma/client";
import Redis from "ioredis";

import {
  createPrismaCacheExtension,
  type PrismaCacheExtensionOptions,
} from "prisma-redis-cache-extension";

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);

// Implement CacheClient using your Redis client
const cache = {
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
    if (options?.ttlMs) {
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
    if (options?.ttlMs) await redis.pexpire(key, options.ttlMs);
  },
};

const cacheOptions: Partial<PrismaCacheExtensionOptions> = {
  cacheableModels: [{ key: "id", model: Prisma.ModelName.User }],
  cachedOperations: ["findUnique", "findFirst"],
  invalidationOperations: ["create", "update", "delete", "upsert"],
  ttlMs: 30_000,
  keyPrefix: "prisma",
};

const prismaWithCache = createPrismaCacheExtension({
  client: prisma,
  cache,
  options: cacheOptions,
});

// Use prismaWithCache as a normal PrismaClient
const user = await prismaWithCache.user.findUnique({
  where: { id: "user-id" },
});
```
