import type { Config } from '../../../config.ts';
import { HttpClient } from '../http.ts';
import type { CatalogProvider } from '../types.ts';
import { ArchiveProvider } from './archive.ts';
import { AudiusProvider } from './audius.ts';
import { CommonsProvider } from './commons.ts';
import { JamendoProvider } from './jamendo.ts';

export { ArchiveProvider } from './archive.ts';
export { AudiusProvider } from './audius.ts';
export { CommonsProvider } from './commons.ts';
export { JamendoProvider } from './jamendo.ts';

/**
 * Источники из конфигурации. Один HttpClient на все источники: лимиты считаются по хосту,
 * а не по провайдеру. Без ключа провайдер остаётся в списке с `enabled = false` и не опрашивается.
 */
export function buildProviders(config: Config, now?: () => number): CatalogProvider[] {
  // Часы приложения сюда не передаются: темп запросов считается по настоящему времени,
  // иначе подменённые в тестах часы заставили бы лимитер спать всё дольше.
  const http = new HttpClient({ userAgent: config.mbUserAgent });
  return [
    new AudiusProvider({ http, appName: config.audius.appName, apiKey: config.audius.apiKey }),
    new JamendoProvider({ http, clientId: config.jamendoClientId }),
    new ArchiveProvider({ http, ...(now ? { now } : {}) }),
    new CommonsProvider({ http }),
  ];
}
