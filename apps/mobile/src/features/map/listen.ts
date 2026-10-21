import type { ListenState, PresenceView } from '@muzradar/shared';

// Чистая логика «слушать вместе»: оценка позиции трека и тексты ошибок.

/** Поток грузится около секунды: начинаем чуть впереди, чтобы не отставать от того, кого слушаем. */
export const LISTEN_LATENCY_SEC = 0.8;
/** Позиция старше этого — уже не про «сейчас»: дальше не экстраполируем. */
const MAX_ELAPSED_SEC = 120;
const CLOCK_SAMPLES = 20;

/**
 * Оценка серверного времени по меткам `at` из пакетов сервера.
 * Часы телефона могут уходить на минуты — поэтому считаем смещение, а не верим Date.now().
 * Метка всегда не позже реального серверного «сейчас», поэтому берём максимум по последним образцам.
 */
export class ServerClock {
  private samples: number[] = [];

  constructor(private readonly localNow: () => number = Date.now) {}

  note(serverAtMs: number, receivedAtMs: number = this.localNow()): void {
    if (!Number.isFinite(serverAtMs) || serverAtMs <= 0) return;
    this.samples.push(serverAtMs - receivedAtMs);
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
  }

  /** Серверное «сейчас» или null, если образцов ещё нет. */
  now(): number | null {
    if (this.samples.length === 0) return null;
    return this.localNow() + Math.max(...this.samples);
  }
}

export const serverClock = new ServerClock();

export type ListenSnapshot = Pick<ListenState, 'positionSec' | 'playing' | 'at'>;

/** С какой секунды включать трек, чтобы попасть туда, где сейчас слушатель. */
export function estimateListenPosition(s: ListenSnapshot, serverNow: number | null): number {
  const base = s.positionSec ?? 0;
  if (!s.playing) return Math.max(0, base);
  const elapsed = serverNow === null ? 0 : Math.min(MAX_ELAPSED_SEC, Math.max(0, (serverNow - s.at) / 1000));
  return Math.max(0, base + elapsed + LISTEN_LATENCY_SEC);
}

/** Снимок из точки на карте — если сервер «слушать вместе» не ответил. */
export function snapshotFromView(v: Pick<PresenceView, 'userId' | 'track' | 'playing' | 'positionSec' | 'updatedAt'>): ListenState {
  return { userId: v.userId, track: v.track, playing: v.playing, positionSec: v.positionSec, at: v.updatedAt };
}

export const LISTEN_ERRORS = {
  notAvailable: 'Слушатель сейчас недоступен — возможно, он скрылся с карты.',
  trackUnavailable: 'Этот трек нельзя включить в МУЗРАДАРЕ.',
  offline: 'Нет связи с сервером: трек включён без синхронизации.',
  failed: 'Не получилось подключиться. Попробуйте ещё раз.',
} as const;

export type ListenErrorKind = 'not_available' | 'offline' | 'failed';

/** Код ошибки из ack или исключения socket.io → что показать. */
export function classifyListenError(err: unknown): ListenErrorKind {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (message === 'not_available' || message === 'not_found') return 'not_available';
  if (/timed? ?out|disconnect|transport|xhr|websocket/i.test(message)) return 'offline';
  return 'failed';
}
