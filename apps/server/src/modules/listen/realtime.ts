import { UserId, type AckResult, type ListenState } from '@muzradar/shared';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { RealtimeSocket } from '../../plugins/realtime.ts';
import { isExpired } from '../presence/memory.ts';
import '../presence/service.ts';
import type { PresenceRecord } from '../presence/store.ts';

/** Комната тех, кто слушает вместе с пользователем. */
export const listenRoom = (userId: string) => `l:${userId}`;
const LISTEN_PREFIX = 'l:';

const Target = z.object({ userId: UserId });

type Reply<T> = (result: AckResult<T>) => void;
function replyOf<T>(ack: unknown): Reply<T> {
  return typeof ack === 'function' ? (ack as Reply<T>) : () => undefined;
}

function sameState(a: PresenceRecord, b: PresenceRecord): boolean {
  return (a.track?.id ?? null) === (b.track?.id ?? null) && a.playing === b.playing && a.positionSec === b.positionSec;
}

/**
 * «Слушать вместе»: подписка на то, что играет у публичного слушателя.
 * Сервер не передаёт звук — только трек и позицию; поток клиент берёт у источника сам.
 */
export default fp(
  async (app) => {
    const stateOf = (r: PresenceRecord): ListenState => ({
      userId: r.userId,
      track: r.track,
      playing: r.playing,
      positionSec: r.positionSec,
      at: app.now(),
    });
    const ended = (userId: string): ListenState => ({ userId, track: null, playing: false, positionSec: null, at: app.now() });

    app.io.on('connection', (socket: RealtimeSocket) => {
      socket.on('listen:join', (payload, ack) => {
        const reply = replyOf<ListenState>(ack);
        const parsed = Target.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: 'bad_payload' });
        const target = parsed.data.userId;
        void (async () => {
          const record = await app.presence.get(target);
          // только живая публичная точка: «для подписчиков» и невидимки недоступны
          if (!record || record.visibility !== 'public' || isExpired(record, app.now())) {
            return reply({ ok: false, error: 'not_available' });
          }
          const room = listenRoom(target);
          // слушать можно одного человека за раз
          for (const r of [...socket.rooms]) if (r.startsWith(LISTEN_PREFIX) && r !== room) await socket.leave(r);
          await socket.join(room);
          reply({ ok: true, data: stateOf(record) });
        })().catch((err: unknown) => {
          app.log.error({ err }, 'listen:join failed');
          reply({ ok: false, error: 'internal' });
        });
      });

      socket.on('listen:leave', (payload, ack) => {
        const reply = replyOf<null>(ack);
        const parsed = Target.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: 'bad_payload' });
        void Promise.resolve(socket.leave(listenRoom(parsed.data.userId))).then(
          () => reply({ ok: true, data: null }),
          () => reply({ ok: false, error: 'internal' }),
        );
      });
    });

    app.presenceEvents.on('changed', (record, prev) => {
      const room = listenRoom(record.userId);
      if (record.visibility !== 'public') {
        // стал «для подписчиков»: незнакомцы больше не слушают вместе
        if (prev?.visibility === 'public') {
          app.io.to(room).emit('listen:state', ended(record.userId));
          app.io.in(room).socketsLeave(room);
        }
        return;
      }
      if (prev && prev.visibility === 'public' && sameState(prev, record)) return;
      app.io.to(room).emit('listen:state', stateOf(record));
    });

    app.presenceEvents.on('removed', (userId) => {
      app.io.to(listenRoom(userId)).emit('listen:state', ended(userId));
    });
  },
  { name: 'listen', dependencies: ['realtime', 'presence'] },
);
