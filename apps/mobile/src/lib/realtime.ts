import { REALTIME_PATH, type AckResult, type ClientToServerEvents, type ServerToClientEvents } from '@muzradar/shared';
import { io, type Socket } from 'socket.io-client';
import { authenticate } from './api';
import { appConfig } from './config';

export type RealtimeClient = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: RealtimeClient | null = null;
let wanted = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function getRealtime(): RealtimeClient {
  if (socket) return socket;
  const s: RealtimeClient = io(appConfig.apiUrl, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    autoConnect: false,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 15_000,
    auth: (cb) => {
      authenticate()
        .then((sess) => cb({ token: sess.accessToken }))
        .catch(() => cb({ token: '' }));
    },
  });

  s.on('auth:expiring', () => {
    authenticate(true)
      .then((sess) => s.emit('auth:renew', { token: sess.accessToken }))
      .catch(() => undefined);
  });

  // Ошибка в серверном middleware отключает автопереподключение — переподключаемся сами.
  s.on('connect_error', (err) => {
    if (!wanted || s.active) return;
    const refresh = err.message === 'unauthorized' ? authenticate(true).catch(() => undefined) : Promise.resolve();
    void refresh.then(() => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (wanted && !s.connected) s.connect();
      }, 3_000);
    });
  });

  socket = s;
  return s;
}

export function connectRealtime() {
  wanted = true;
  const s = getRealtime();
  if (!s.connected && !s.active) s.connect();
}

export function disconnectRealtime() {
  wanted = false;
  if (retryTimer) clearTimeout(retryTimer);
  socket?.disconnect();
}

/** emit с подтверждением и таймаутом; ошибка сервера — исключение. */
export async function emitAck<E extends keyof ClientToServerEvents, T>(
  event: E,
  payload: Parameters<ClientToServerEvents[E]>[0],
  timeoutMs = 5_000,
): Promise<T> {
  const timed = getRealtime().timeout(timeoutMs);
  // socket.io-client выводит тип ответа из колбэка события; здесь он уже известен как AckResult<T>
  const emit = timed.emitWithAck as unknown as (ev: E, p: unknown) => Promise<AckResult<T>>;
  const result = await emit.call(timed, event, payload);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
