export {
  createPrismaCacheExtension,
  withCacheExtension,
  invalidateCache,
  type CacheClient,
  type CacheableModel,
  type PrismaCacheExtensionOptions,
  type PrismaCacheLogger,
} from "./cache-extension";

export { createRedisCacheClient } from "./redis-ioredis-adapter";


