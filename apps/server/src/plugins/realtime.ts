import { REALTIME_PATH, type ClientToServerEvents, type ServerToClientEvents, type SocketData } from '@muzradar/shared';
import fp from 'fastify-plugin';
import { Server, type ServerOptions, type Socket } from 'socket.io';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface InterServerEvents {}

export type RealtimeServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type RealtimeSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

declare module 'fastify' {
  interface FastifyInstance {
    io: RealtimeServer;
  }
}

/** Комната всех сокетов пользователя (несколько устройств). */
export const userRoom = (userId: string) => `u:${userId}`;

/** Сколько секунд после истечения токена сокет живёт в ожидании `auth:renew`. */
const RENEW_GRACE_SEC = 60;

export default fp<{ adapter?: ServerOptions['adapter'] }>(
  async (app, opts) => {
    const io: RealtimeServer = new Server(app.server, {
      path: REALTIME_PATH,
      // только websocket → не нужны sticky-сессии за балансировщиком
      transports: ['websocket'],
      maxHttpBufferSize: 16_000,
      pingInterval: 25_000,
      pingTimeout: 20_000,
      connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, skipMiddlewares: false },
      ...(opts.adapter ? { adapter: opts.adapter } : {}),
    });

    io.use((socket, next) => {
      const raw: unknown = socket.handshake.auth?.['token'];
      try {
        const claims = app.verifyAccessToken(typeof raw === 'string' ? raw : '');
        if (!claims.ob) return next(new Error('onboarding_required'));
        socket.data.userId = claims.sub;
        socket.data.deviceId = claims.did;
        socket.data.tokenExp = claims.exp;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });

    io.on('connection', (socket) => {
      void socket.join(userRoom(socket.data.userId));

      let warnTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const schedule = () => {
        clearTimeout(warnTimer);
        clearTimeout(killTimer);
        const msToExp = socket.data.tokenExp * 1000 - Date.now();
        warnTimer = setTimeout(() => socket.emit('auth:expiring', { inSec: 60 }), Math.max(0, msToExp - 60_000));
        killTimer = setTimeout(() => socket.disconnect(true), Math.max(0, msToExp + RENEW_GRACE_SEC * 1000));
      };
      schedule();

      socket.on('auth:renew', (payload, ack) => {
        try {
          const token = typeof payload?.token === 'string' ? payload.token : '';
          const claims = app.verifyAccessToken(token);
          if (claims.sub !== socket.data.userId || !claims.ob) throw new Error('mismatch');
          socket.data.tokenExp = claims.exp;
          schedule();
          ack?.({ ok: true, data: null });
        } catch {
          ack?.({ ok: false, error: 'unauthorized' });
        }
      });

      socket.on('disconnect', () => {
        clearTimeout(warnTimer);
        clearTimeout(killTimer);
      });
    });

    app.decorate('io', io);
    // без этих хуков app.close() висит, пока открыт хотя бы один websocket
    app.addHook('preClose', async () => {
      io.local.disconnectSockets(true);
    });
    app.addHook('onClose', async () => {
      await io.close();
    });
  },
  { name: 'realtime', dependencies: ['auth'] },
);
