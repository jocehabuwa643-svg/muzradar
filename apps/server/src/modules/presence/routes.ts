import { EventEmitter } from 'node:events';
import {
  ClustersResponse,
  NearbyResponse,
  PresenceHeartbeat,
  PresenceUpdate,
  Viewport,
  ViewportQuery,
  type AckResult,
  type ViewportAck,
} from '@muzradar/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { httpError } from '../../plugins/errors.ts';
import type { RealtimeSocket } from '../../plugins/realtime.ts';
import { PresenceService, ROOM_PREFIX, SocketLimits, type PresenceEventMap } from './service.ts';

const SWEEP_INTERVAL_MS = 5_000;

/** HTTP: снимок, кластеры и тот же путь обновления, что у сокета (фоновая задача без сокета). */
const httpRoutes: FastifyPluginAsyncZod<{ service: PresenceService }> = async (app, { service }) => {
  // хук уровня плагина идёт раньше хука лимитов: ключ лимита — пользователь, а не IP
  app.addHook('onRequest', app.requireOnboarded);

  app.get(
    '/nearby',
    { schema: { querystring: ViewportQuery, response: { 200: NearbyResponse } } },
    async (req) => ({ users: await service.snapshot(req.query.bbox, req.query.zoom) }),
  );

  app.get(
    '/clusters',
    { schema: { querystring: ViewportQuery, response: { 200: ClustersResponse } } },
    async (req) => service.clusters(req.query.bbox, req.query.zoom),
  );

  app.post(
    '/',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { body: PresenceUpdate } },
    async (req, reply) => {
      await service.update(req.user.sub, req.body);
      return reply.code(204).send();
    },
  );

  app.post(
    '/heartbeat',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } }, schema: { body: PresenceHeartbeat } },
    async (req, reply) => {
      const outcome = await service.heartbeat(req.user.sub, req.body);
      // точки нет (истекла) — клиент должен прислать полное обновление с ячейкой
      if (outcome === 'missing') throw httpError.notFound('presence_not_found', 'Точка на карте истекла, отправьте позицию заново');
      return reply.code(204).send();
    },
  );
};

type Reply<T> = (result: AckResult<T>) => void;

/** Ack от клиента может отсутствовать или быть не функцией — не падаем. */
function replyOf<T>(ack: unknown): Reply<T> {
  return typeof ack === 'function' ? (ack as Reply<T>) : () => undefined;
}

function attachSocketHandlers(app: FastifyInstance, service: PresenceService) {
  const run = <T>(reply: Reply<T>, work: () => Promise<AckResult<T>>) => {
    work().then(reply, (err: unknown) => {
      app.log.error({ err }, 'presence socket handler failed');
      reply({ ok: false, error: 'internal' });
    });
  };

  app.io.on('connection', (socket: RealtimeSocket) => {
    const userId = socket.data.userId;
    const limits = new SocketLimits(() => app.now());

    socket.on('viewport:set', (payload, ack) => {
      const reply = replyOf<ViewportAck>(ack);
      const parsed = Viewport.safeParse(payload);
      if (!parsed.success) return reply({ ok: false, error: 'bad_payload' });
      if (!limits.viewport()) return reply({ ok: false, error: 'rate_limited' });
      const { bbox, zoom } = parsed.data;
      run(reply, async () => {
        const rooms = service.viewportRooms(bbox, zoom);
        const wanted = new Set(rooms ?? []);
        for (const room of [...socket.rooms]) {
          if (room.startsWith(ROOM_PREFIX) && !wanted.has(room)) await socket.leave(room);
        }
        if (wanted.size > 0) await socket.join([...wanted]);
        if (!rooms) return { ok: true, data: { mode: 'clusters' as const, rooms: 0, users: [] } };
        return { ok: true, data: { mode: 'live' as const, rooms: rooms.length, users: await service.snapshot(bbox, zoom) } };
      });
    });

    socket.on('presence:update', (payload, ack) => {
      const reply = replyOf<null>(ack);
      const parsed = PresenceUpdate.safeParse(payload);
      if (!parsed.success) return reply({ ok: false, error: 'bad_payload' });
      if (!limits.update()) return reply({ ok: false, error: 'rate_limited' });
      run(reply, async () => {
        await service.update(userId, parsed.data);
        return { ok: true, data: null };
      });
    });

    socket.on('presence:heartbeat', (payload, ack) => {
      const reply = replyOf<null>(ack);
      const parsed = PresenceHeartbeat.safeParse(payload);
      if (!parsed.success) return reply({ ok: false, error: 'bad_payload' });
      if (!limits.heartbeat()) return reply({ ok: false, error: 'rate_limited' });
      run(reply, async () => {
        const outcome = await service.heartbeat(userId, parsed.data);
        return outcome === 'missing' ? { ok: false, error: 'not_found' } : { ok: true, data: null };
      });
    });
  });
}

/**
 * Присутствие на карте. Обёрнут в fastify-plugin, чтобы `presenceEvents` был виден
 * модулю «слушать вместе»; prefix fastify-plugin игнорирует, поэтому HTTP-маршруты
 * регистрируются вложенным плагином с тем же префиксом.
 */
export default fp<{ prefix?: string }>(
  async (app, opts) => {
    const events = new EventEmitter<PresenceEventMap>();
    app.decorate('presenceEvents', events);
    const service = new PresenceService(app, events);

    attachSocketHandlers(app, service);
    await app.register(httpRoutes, { prefix: opts.prefix ?? '/v1/presence', service });

    let sweeping = false;
    const sweeper = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      service
        .sweep()
        .catch((err: unknown) => app.log.error({ err }, 'presence sweep failed'))
        .finally(() => {
          sweeping = false;
        });
    }, SWEEP_INTERVAL_MS);
    sweeper.unref();

    // хранилище не закрываем: им владеет вызывающий (index.ts, тесты)
    app.addHook('onClose', async () => {
      clearInterval(sweeper);
      service.stop();
    });
  },
  { name: 'presence', dependencies: ['auth', 'rate-limit', 'realtime'] },
);
