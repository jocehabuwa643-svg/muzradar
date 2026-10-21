import type { ListenState, PresenceHeartbeat, PresenceUpdate, PresenceView, UserId, Viewport } from './schemas.ts';

/** Ответ на событие с подтверждением (Socket.IO ack). */
export type AckResult<T> = { ok: true; data: T } | { ok: false; error: string };
export type Ack<T = null> = (result: AckResult<T>) => void;

export interface ViewportAck {
  /** live — точки приходят потоком; clusters — зум мелкий, клиент берёт кластеры по HTTP. */
  mode: 'live' | 'clusters';
  rooms: number;
  users: PresenceView[];
}

export interface ServerToClientEvents {
  /** Пакет изменений по комнатам вьюпорта; не чаще раза в PRESENCE.batchMs. */
  'presence:delta': (payload: { upserts: PresenceView[]; removes: UserId[]; at: number }) => void;
  /** Слушатель, к которому присоединились, сменил трек/паузу/позицию. */
  'listen:state': (payload: ListenState) => void;
  /** Токен истекает через `inSec` — пришлите свежий через `auth:renew`. */
  'auth:expiring': (payload: { inSec: number }) => void;
  /** Сервер закрывает сессию: аккаунт удалён или заблокирован. */
  'session:revoked': (payload: { reason: string }) => void;
}

export interface ClientToServerEvents {
  'presence:update': (payload: PresenceUpdate, ack?: Ack) => void;
  'presence:heartbeat': (payload: PresenceHeartbeat, ack?: Ack) => void;
  'viewport:set': (payload: Viewport, ack?: Ack<ViewportAck>) => void;
  'listen:join': (payload: { userId: UserId }, ack?: Ack<ListenState>) => void;
  'listen:leave': (payload: { userId: UserId }, ack?: Ack) => void;
  'auth:renew': (payload: { token: string }, ack?: Ack) => void;
}

export interface SocketData {
  userId: UserId;
  deviceId: string;
  tokenExp: number;
}

export const REALTIME_PATH = '/v1/realtime';
