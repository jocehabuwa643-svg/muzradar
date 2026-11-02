import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { ServerOptions } from 'socket.io';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Database } from './db/client.ts';
import authRoutes from './modules/auth/routes.ts';
import avatarRoutes from './modules/avatars/routes.ts';
import catalogRoutes from './modules/catalog/routes.ts';
import type { CatalogProvider } from './modules/catalog/types.ts';
import listenModule from './modules/listen/realtime.ts';
import meRoutes from './modules/me/routes.ts';
import presenceModule from './modules/presence/routes.ts';
import pwaRoutes from './modules/pwa/routes.ts';
import type { PresenceStore } from './modules/presence/store.ts';
import authPlugin from './plugins/auth.ts';
import errorsPlugin from './plugins/errors.ts';
import rateLimitPlugin from './plugins/rate-limit.ts';
import realtimePlugin from './plugins/realtime.ts';
import './types.ts';

export interface AppDeps {
  config: Config;
  database: Database;
  presence: PresenceStore;
  redis?: Redis;
  socketAdapter?: ServerOptions['adapter'];
  /** Подмена источников каталога (тесты). */
  catalogProviders?: CatalogProvider[];
  /** Подмена часов (тесты). */
  now?: () => number;
  logger?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    trustProxy: config.trustProxy ?? false,
    bodyLimit: 64 * 1024,
    requestIdHeader: 'x-request-id',
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('config', config);
  app.decorate('db', deps.database.db);
  app.decorate('presence', deps.presence);
  app.decorate('now', deps.now ?? Date.now);

  await app.register(errorsPlugin);
  await app.register(cors, { origin: config.corsOrigins });
  await app.register(authPlugin, { secret: config.jwtSecret, ttlSec: config.accessTokenTtlSec });
  await app.register(rateLimitPlugin, deps.redis ? { redis: deps.redis } : {});
  await app.register(realtimePlugin, deps.socketAdapter ? { adapter: deps.socketAdapter } : {});

  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        response: {
          200: z.object({ ok: z.literal(true), db: z.boolean(), presence: z.enum(['memory', 'redis']) }),
        },
      },
    },
    async () => {
      const db = await deps.database.pool
        .query('select 1')
        .then(() => true)
        .catch(() => false);
      return { ok: true as const, db, presence: deps.presence.kind };
    },
  );

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(meRoutes, { prefix: '/v1/me' });
  await app.register(avatarRoutes, { prefix: '/v1/avatars' });
  await app.register(catalogRoutes, {
    prefix: '/v1/catalog',
    ...(deps.catalogProviders ? { providers: deps.catalogProviders } : {}),
  });
  await app.register(presenceModule, { prefix: '/v1/presence' });
  await app.register(listenModule);
  if (config.pwaStaticDir) await app.register(pwaRoutes, { root: config.pwaStaticDir });

  return app;
}
