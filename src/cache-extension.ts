import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

//
// PUBLIC TYPES
//

export type CacheClient = {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(
    key: string,
    value: T,
    options?: { ttlMs?: number },
  ): Promise<void>;
  del(key: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  sadd(
    key: string,
    member: string,
    options?: { ttlMs?: number },
  ): Promise<void>;
};

export type CacheableModel = {
  key: string;
  model: string;
};

export type PrismaCacheExtensionOptions = {
  cacheableModels: CacheableModel[];
  cachedOperations: string[];
  invalidationOperations: string[];
  /** Default TTL in milliseconds for cached entries (default: 30_000) */
  ttlMs?: number;
  /** Optional key prefix/namespace, e.g. "prisma" */
  keyPrefix?: string;
};

export type PrismaCacheLogger = {
  debug(message: string): void;
  warn(message: string): void;
};

//
// DEFAULT CONFIGURATION
// You can override this when wiring the extension in your app.
//

const defaultCacheOptions: PrismaCacheExtensionOptions = {
  // Pass cacheableModels when creating the extension, e.g.:
  // options: { cacheableModels: [{ key: "id", model: "User" }], ... }
  cacheableModels: [],
  cachedOperations: ["findFirst", "findUnique"],
  invalidationOperations: ["create", "update", "delete", "upsert"],
  ttlMs: 30_000,
  keyPrefix: "prisma",
};

/**
 * Create a reusable Prisma extension that adds Redis-style caching.
 *
 * Pass config from the outside via `options`, including which models to cache:
 *
 * @example
 * createPrismaCacheExtension({
 *   client: prisma,
 *   cache,
 *   options: {
 *     cacheableModels: [{ key: "id", model: "User" }, { key: "id", model: "Post" }],
 *     cachedOperations: ["findUnique", "findFirst"],
 *     invalidationOperations: ["create", "update", "delete", "upsert"],
 *     ttlMs: 30_000,
 *     keyPrefix: "myapp",
 *   },
 * });
 */
export function createPrismaCacheExtension(params: {
  client: PrismaClient;
  cache: CacheClient;
  options?: Partial<PrismaCacheExtensionOptions>;
  logger?: PrismaCacheLogger;
}) {
  const { client, cache, options, logger } = params;

  const mergedOptions: PrismaCacheExtensionOptions = {
    ...defaultCacheOptions,
    ...options,
    cacheableModels:
      options?.cacheableModels ?? defaultCacheOptions.cacheableModels,
    cachedOperations:
      options?.cachedOperations ?? defaultCacheOptions.cachedOperations,
    invalidationOperations:
      options?.invalidationOperations ??
      defaultCacheOptions.invalidationOperations,
  };

  const effectiveLogger = logger ?? defaultLogger;

  return withCacheExtensionInternal({
    client,
    cache,
    options: mergedOptions,
    logger: effectiveLogger,
  });
}

/**
 * Backwards-compatible helper with a simpler signature.
 * Requires you to pass a `CacheClient` implementation.
 */
export function withCacheExtension(
  client: PrismaClient,
  cache: CacheClient,
  options?: Partial<PrismaCacheExtensionOptions>,
  logger?: PrismaCacheLogger,
) {
  return createPrismaCacheExtension({ client, cache, options, logger });
}

type InternalContext = {
  client: PrismaClient;
  cache: CacheClient;
  options: PrismaCacheExtensionOptions;
  logger: PrismaCacheLogger;
};

function withCacheExtensionInternal(ctx: InternalContext) {
  const { client, options } = ctx;
  const { cacheableModels, cachedOperations, invalidationOperations } =
    options;

  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args,
          model,
          operation,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          query,
        }: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: any;
          model: string;
          operation: string;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          query: (args: any) => Promise<unknown>;
        }) {
          // Only act on models we care about
          const modelConfig = cacheableModels.find((m) => m.model === model);
          if (!modelConfig) return query(args);

          // Handle read queries (cacheable operations)
          if (cachedOperations.includes(operation)) {
            return executeWithCache({
              ctx,
              action: operation,
              args,
              model,
              modelConfig,
              query,
            });
          }

          // Handle write operations that should invalidate cache
          if (invalidationOperations.includes(operation)) {
            const result = await query(args);
            await invalidateCache(ctx, model, result);
            return result;
          }

          return query(args);
        },
      },
    },
  });
}

//
// PUBLIC FUNCTIONS
//

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function invalidateCache(ctx: InternalContext, model: string, record: any) {
  const { cache, options, logger } = ctx;
  const modelConfig = options.cacheableModels.find((m) => m.model === model);
  if (!modelConfig) return;

  const entityIdField = modelConfig.key;
  const entityId = record[entityIdField];

  if (!entityId) {
    logger.warn(`[PrismaCache] [INVALIDATE] No ID found for model ${model}`);
    return;
  }

  const entityKey = generateEntityIndexKey(options, model, entityId);

  // Get all related query cache keys
  const relatedKeys = await cache.smembers(entityKey);

  if (relatedKeys.length > 0) {
    logger.debug(
      `[PrismaCache] [INVALIDATE] Removing keys: ${relatedKeys.join(", ")}`,
    );

    // Delete all cached queries related to the entity
    await Promise.all(relatedKeys.map((key) => cache.del(key)));

    // Delete the index entry itself
    await cache.del(entityKey);
  }
}

//
// INTERNAL FUNCTIONS
//

const defaultLogger: PrismaCacheLogger = {
  debug: (message: string) => {
    // eslint-disable-next-line no-console
    console.debug(message);
  },
  warn: (message: string) => {
    // eslint-disable-next-line no-console
    console.warn(message);
  },
};

type ExecuteWithCacheArgs = {
  ctx: InternalContext;
  action: string;
  args: unknown;
  model: string;
  modelConfig: CacheableModel;
  query: (args: unknown) => Promise<unknown>;
};

async function executeWithCache(cacheArgs: ExecuteWithCacheArgs) {
  const { ctx, action, args, model, modelConfig, query } = cacheArgs;
  const { cache, options, logger } = ctx;

  const ttlMs = options.ttlMs ?? 30_000;

  // Generate cache key based on query args
  const cacheKey = generateCacheKey(options, model, action, args);

  const entityIdField = modelConfig.key;

  // Check cache first
  const cachedResult = await cache.get(cacheKey);
  if (cachedResult) {
    logger.debug(`[PrismaCache] [HIT] ${cacheKey}`);
    return cachedResult;
  }

  // Execute query
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await query(args)) as any;
  if (result) {
    logger.debug(`[PrismaCache] [SET] ${cacheKey}`);

    // Store the cache entry
    await cache.set(cacheKey, result, { ttlMs });

    // If entity has a valid ID, track it in an index
    if (result[entityIdField]) {
      const entityKey = generateEntityIndexKey(
        options,
        model,
        result[entityIdField],
      );
      await cache.sadd(entityKey, cacheKey, { ttlMs }); // Add cacheKey to set
    }
  }
  return result;
}

/** Generate unique cache key for `findUnique` and `findFirst` */
function generateCacheKey(
  options: PrismaCacheExtensionOptions,
  model: string,
  _action: string,
  args: unknown,
): string {
  const argsHash = hashObject(args);
  const prefix = options.keyPrefix ? `${options.keyPrefix}:` : "";
  return `${prefix}${model}:${argsHash}`;
}

function sortKeys<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return obj;
  }

  return Object.fromEntries(
    Object.entries(obj)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([key, value]) => [key, sortKeys(value)]),
  ) as T;
}

function hashObject<T>(obj: T): string {
  // Normalize Prisma query args before hashing
  const filteredObj = sortKeys(obj);

  // Convert to a Buffer (faster than raw JSON.stringify hashing)
  const jsonBuffer = Buffer.from(JSON.stringify(filteredObj));

  return crypto.createHash("md5").update(jsonBuffer).digest("hex");
}

/** Generate the cache key for entity index tracking */
function generateEntityIndexKey(
  options: PrismaCacheExtensionOptions,
  model: string,
  entityId: string,
): string {
  const prefix = options.keyPrefix ? `${options.keyPrefix}:` : "";
  return `${prefix}${model}:${entityId}:index`;
}

