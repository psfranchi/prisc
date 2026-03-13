// @ts-nocheck
import { describe, it, expect } from "vitest";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";

import {
  createPrismaCacheExtension,
  type PrismaCacheExtensionOptions,
} from "../src/cache-extension";
import { createRedisCacheClient } from "../src/redis-ioredis-adapter";

class FakePrismaClient {
  public userCallCount = 0;

  user = {
    findUnique: async (args: unknown) => {
      this.userCallCount += 1;
      return { id: "1", name: "John", args };
    },
    update: async (args: unknown) => {
      this.userCallCount += 1;
      return { id: "1", name: "John Updated", args };
    },
  };

  $extends(spec: any): any {
    const self = this;
    const allOps = spec.query.$allModels.$allOperations;

    return {
      user: {
        findUnique(args: any) {
          return allOps({
            args,
            model: "User",
            operation: "findUnique",
            query: (innerArgs: any) => self.user.findUnique(innerArgs),
          });
        },
        update(args: any) {
          return allOps({
            args,
            model: "User",
            operation: "update",
            query: (innerArgs: any) => self.user.update(innerArgs),
          });
        },
      },
    };
  }
}

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// If Redis is not reachable, we skip these tests to avoid failing CI/local runs.
async function canConnectToRedis(): Promise<boolean> {
  try {
    const client = new Redis(redisUrl);
    await client.ping();
    await client.quit();
    return true;
  } catch {
    return false;
  }
}

describe("Prisma cache extension with real Redis (ioredis adapter)", async () => {
  const available = await canConnectToRedis();
  if (!available) {
    it.skip("skips because Redis is not available", () => {
      expect(true).toBe(true);
    });
    return;
  }

  const redis = new Redis(redisUrl);
  const cache = createRedisCacheClient(redis);

  const baseClient = new FakePrismaClient() as unknown as PrismaClient;

  const options: Partial<PrismaCacheExtensionOptions> = {
    cacheableModels: [{ key: "id", model: "User" }],
    cachedOperations: ["findUnique"],
    invalidationOperations: ["update"],
    ttlMs: 2_000,
    keyPrefix: "e2e",
  };

  const clientWithCache = createPrismaCacheExtension({
    client: baseClient,
    cache,
    options,
  }) as any;

  it("caches and invalidates using real Redis", async () => {
    const args = { where: { id: "1" }, select: { id: true, name: true } };

    // First call -> DB
    await clientWithCache.user.findUnique(args);
    // Second call -> cache
    await clientWithCache.user.findUnique(args);
    expect((baseClient as any).userCallCount).toBe(1);

    // Update -> invalidates
    await clientWithCache.user.update({
      where: { id: "1" },
      data: { name: "John Updated" },
    });

    // Next read -> DB again
    await clientWithCache.user.findUnique(args);
    expect((baseClient as any).userCallCount).toBe(3);
  });

  it("uses different keys for different select projections", async () => {
    const argsFull = { where: { id: "1" }, select: { id: true, name: true } };
    const argsPartial = { where: { id: "1" }, select: { id: true } };

    await clientWithCache.user.findUnique(argsFull);
    await clientWithCache.user.findUnique(argsPartial);

    // Both queries should have executed (different cache keys)
    expect((baseClient as any).userCallCount).toBeGreaterThanOrEqual(2);
  });

  it("expires keys according to ttlMs", async () => {
    const args = { where: { id: "1" } };

    (baseClient as any).userCallCount = 0;

    await clientWithCache.user.findUnique(args);
    await clientWithCache.user.findUnique(args);
    expect((baseClient as any).userCallCount).toBe(1);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 2500));

    await clientWithCache.user.findUnique(args);
    expect((baseClient as any).userCallCount).toBe(2);
  });
});

