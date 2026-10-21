import rateLimit from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';

/**
 * Лимиты включаются на маршрутах через `config.rateLimit`.
 * Ключ — пользователь, если токен уже проверен хуком маршрута, иначе IP.
 * Лимиты по IP щедрые: за одним IP оператора (CGNAT) — тысячи абонентов.
 */
export default fp<{ redis?: Redis }>(
  async (app, opts) => {
    await app.register(rateLimit, {
      global: false,
      ...(opts.redis ? { redis: opts.redis, nameSpace: 'mr:rl:', skipOnError: true } : {}),
      keyGenerator: (req: FastifyRequest) => {
        const sub = (req.user as { sub?: string } | undefined)?.sub;
        return sub ? `u:${sub}` : `ip:${req.ip}`;
      },
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        error: 'rate_limited',
        message: `Слишком много запросов, повторите через ${Math.ceil(ctx.ttl / 1000)} с`,
      }),
    });
  },
  { name: 'rate-limit', dependencies: ['auth'] },
);
