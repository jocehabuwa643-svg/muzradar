import type { Redis } from 'ioredis';
import type { Config } from '../../config.ts';
import { MemoryPresenceStore } from './memory.ts';
import { RedisPresenceStore } from './redis.ts';
import type { PresenceStore } from './store.ts';

/** Без REDIS_URL — память процесса (одна нода); с ним — Redis, общий для всех нод. */
export function createPresenceStore(_config: Config, redis?: Redis): PresenceStore {
  return redis ? new RedisPresenceStore(redis) : new MemoryPresenceStore();
}
