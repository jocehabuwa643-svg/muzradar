import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import type { PresenceStore } from './modules/presence/store.ts';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    presence: PresenceStore;
    /** Часы приложения (подменяются в тестах). */
    now(): number;
  }
}

/** Абсолютная или относительная ссылка на файл аватара. */
export function avatarUrl(config: Pick<Config, 'assetsBaseUrl'>, hash: string, variant: 'full' | 'map'): string {
  const path = variant === 'full' ? `/v1/avatars/${hash}.webp` : `/v1/avatars/${hash}/map.webp`;
  return `${config.assetsBaseUrl}${path}`;
}
