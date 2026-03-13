import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

import {
  createPrismaCacheExtension,
  createRedisCacheClient,
  type PrismaCacheExtensionOptions,
} from "prisma-redis-cache-extension";

/**
 * Example NestJS service that wires PrismaClient + Redis + the cache extension.
 *
 * In a real app you would also configure your Prisma schema and migrations.
 */
@Injectable()
export class PrismaCacheService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

  constructor() {
    const baseClient = new PrismaClient();
    const cache = createRedisCacheClient(
      // consumer is responsible for managing connection lifecycle
      // here we just create a dedicated client
      new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379"),
    );

    const options: Partial<PrismaCacheExtensionOptions> = {
      cacheableModels: [{ key: "id", model: "User" }],
      cachedOperations: ["findUnique", "findFirst"],
      invalidationOperations: ["create", "update", "delete", "upsert"],
      ttlMs: 30_000,
      keyPrefix: "nest-example",
    };

    const extended = createPrismaCacheExtension({
      client: baseClient,
      cache,
      options,
    }) as PrismaClient;

    // Call PrismaClient constructor with the extended client's options
    super(extended.$options);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.redis.quit();
  }
}

