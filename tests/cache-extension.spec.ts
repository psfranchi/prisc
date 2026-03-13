// @ts-nocheck
import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  createPrismaCacheExtension,
  type CacheClient,
  type PrismaCacheExtensionOptions,
} from "../src/cache-extension";

class InMemoryCache implements CacheClient {
  private store = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    _options?: { ttlMs?: number },
  ): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.sets.delete(key);
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async sadd(
    key: string,
    member: string,
    _options?: { ttlMs?: number },
  ): Promise<void> {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(member);
    this.sets.set(key, set);
  }
}

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

describe("Prisma cache extension", () => {
  it("caches repeated read queries", async () => {
    const baseClient = new FakePrismaClient() as unknown as PrismaClient;
    const cache = new InMemoryCache();

    const options: Partial<PrismaCacheExtensionOptions> = {
      cacheableModels: [{ key: "id", model: "User" }],
      cachedOperations: ["findUnique"],
      invalidationOperations: ["update"],
      ttlMs: 5_000,
      keyPrefix: "test",
    };

    const clientWithCache = createPrismaCacheExtension({
      client: baseClient,
      cache,
      options,
    }) as any;

    const args = { where: { id: "1" } };

    const first = await clientWithCache.user.findUnique(args);
    const second = await clientWithCache.user.findUnique(args);

    expect(first).toEqual(second);
    // Underlying findUnique should have been called only once
    expect((baseClient as any).userCallCount).toBe(1);
  });

  it("invalidates cache on write operations", async () => {
    const baseClient = new FakePrismaClient() as unknown as PrismaClient;
    const cache = new InMemoryCache();

    const options: Partial<PrismaCacheExtensionOptions> = {
      cacheableModels: [{ key: "id", model: "User" }],
      cachedOperations: ["findUnique"],
      invalidationOperations: ["update"],
      ttlMs: 5_000,
      keyPrefix: "test",
    };

    const clientWithCache = createPrismaCacheExtension({
      client: baseClient,
      cache,
      options,
    }) as any;

    const args = { where: { id: "1" } };

    await clientWithCache.user.findUnique(args);
    await clientWithCache.user.findUnique(args);
    expect((baseClient as any).userCallCount).toBe(1);

    // Perform a write that should invalidate cache
    await clientWithCache.user.update({
      where: { id: "1" },
      data: { name: "John Updated" },
    });

    // Next read should hit underlying client again
    await clientWithCache.user.findUnique(args);
    expect((baseClient as any).userCallCount).toBe(3);
  });
});

