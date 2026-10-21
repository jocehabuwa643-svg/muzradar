import { existsSync } from 'node:fs';
import { Redis } from 'ioredis';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/client.ts';
import { createPresenceStore } from './modules/presence/factory.ts';

// Локальный .env для разработки; в продакшене переменные приходят из окружения.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();

const redis = config.redisUrl
  ? new Redis(config.redisUrl, { protocol: 2, maxRetriesPerRequest: 2, connectTimeout: 2_000, lazyConnect: false })
  : undefined;

const database = await openDatabase(config);
const presence = createPresenceStore(config, redis);
const app = await buildApp({ config, database, presence, ...(redis ? { redis } : {}) });

if (config.usingDevSecrets) app.log.warn('dev secrets in use — set JWT_SECRET, PRESENCE_JITTER_SECRET, ANDROID_ID_PEPPER');
if (database.embedded) app.log.info({ url: database.url }, 'embedded PGlite database (dev only)');
app.log.info({ presence: presence.kind }, 'presence store');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.close();
    await presence.close();
    await database.close();
    redis?.disconnect();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
