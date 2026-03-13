import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Redis from "ioredis";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { PrismaCacheService } from "../src/prisma-cache.service";
import {
  createPrismaCacheExtension,
  createRedisCacheClient,
  type PrismaCacheExtensionOptions,
} from "prisma-redis-cache-extension";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

/** Fake Prisma client that tracks call counts so we can assert cache hits/misses. */
class FakePrismaClient {
  public userFindUniqueCount = 0;
  public userUpdateCount = 0;

  user = {
    findUnique: async (args: unknown) => {
      this.userFindUniqueCount += 1;
      return { id: "1", name: "John", args };
    },
    update: async (args: unknown) => {
      this.userUpdateCount += 1;
      const data = (args as { data?: { name?: string } })?.data ?? {};
      return { id: "1", name: data.name ?? "John Updated", args };
    },
  };

  $connect = async () => {};
  $disconnect = async () => {};

  $extends(spec: {
    query: { $allModels: { $allOperations: (opts: unknown) => Promise<unknown> } };
  }) {
    const self = this;
    const allOps = spec.query.$allModels.$allOperations;
    return {
      user: {
        findUnique(args: unknown) {
          return allOps({
            args,
            model: "User",
            operation: "findUnique",
            query: (a: unknown) => self.user.findUnique(a),
          });
        },
        update(args: unknown) {
          return allOps({
            args,
            model: "User",
            operation: "update",
            query: (a: unknown) => self.user.update(a),
          });
        },
      },
      $connect: self.$connect,
      $disconnect: self.$disconnect,
    };
  }
}

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

describe("AppController (e2e with Redis cache)", () => {
  let app: INestApplication;
  let redis: Redis;
  let fakePrisma: FakePrismaClient;

  beforeAll(async () => {
    const redisAvailable = await canConnectToRedis();
    if (!redisAvailable) {
      console.warn("Redis not available at " + redisUrl + "; skipping e2e cache tests.");
      return;
    }

    fakePrisma = new FakePrismaClient();
    redis = new Redis(redisUrl);
    const cache = createRedisCacheClient(redis);

    const options: PrismaCacheExtensionOptions = {
      cacheableModels: [{ key: "id", model: "User" }],
      cachedOperations: ["findUnique", "findFirst"],
      invalidationOperations: ["create", "update", "delete", "upsert"],
      ttlMs: 800,
      keyPrefix: "nest-e2e",
    };

    const extendedPrisma = createPrismaCacheExtension({
      client: fakePrisma as unknown as import("@prisma/client").PrismaClient,
      cache,
      options,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaCacheService)
      .useValue(extendedPrisma)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (redis) await redis.quit();
  });

  it("uses Redis cache: second GET with same args hits cache (no extra Prisma call)", async () => {
    if (!app || !fakePrisma || !redis) return;

    await redis.flushdb();
    fakePrisma.userFindUniqueCount = 0;

    await request(app.getHttpServer()).get("/user?id=1").expect(200);
    await request(app.getHttpServer()).get("/user?id=1").expect(200);

    expect(fakePrisma.userFindUniqueCount).toBe(1);
  });

  it("invalidates cache on update: after PATCH, next GET hits Prisma again", async () => {
    if (!app || !fakePrisma || !redis) return;

    await redis.flushdb();
    fakePrisma.userFindUniqueCount = 0;
    fakePrisma.userUpdateCount = 0;

    await request(app.getHttpServer()).get("/user?id=1").expect(200);
    expect(fakePrisma.userFindUniqueCount).toBe(1);

    await request(app.getHttpServer())
      .patch("/user/1")
      .send({ name: "Jane" })
      .expect(200);
    expect(fakePrisma.userUpdateCount).toBe(1);

    await request(app.getHttpServer()).get("/user?id=1").expect(200);
    expect(fakePrisma.userFindUniqueCount).toBe(2);
  });

  it("respects TTL: after ttlMs expires, next GET hits Prisma again", async () => {
    if (!app || !fakePrisma || !redis) return;

    await redis.flushdb();
    fakePrisma.userFindUniqueCount = 0;

    await request(app.getHttpServer()).get("/user?id=1").expect(200);
    await request(app.getHttpServer()).get("/user?id=1").expect(200);
    expect(fakePrisma.userFindUniqueCount).toBe(1);

    await new Promise((r) => setTimeout(r, 1000));

    await request(app.getHttpServer()).get("/user?id=1").expect(200);
    expect(fakePrisma.userFindUniqueCount).toBe(2);
  });
});
