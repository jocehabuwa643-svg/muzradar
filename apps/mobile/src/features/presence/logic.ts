import {
  approxCellOf,
  motionFromSpeed,
  nextPresenceCell,
  type Motion,
  type PresenceHeartbeat,
  type PresenceUpdate,
  type Track,
  type TrackRef,
} from '@muzradar/shared';

// Чистая логика публикации присутствия: без React, сокета и геолокации — чтобы её можно было проверить тестами.

export type PublisherMode = 'watch' | 'heartbeat' | 'idle';

export interface PublisherInputs {
  onboarded: boolean;
  /** Состояние AppState; всё, кроме 'background', считается экраном (iOS 'inactive' — шторка, не фон). */
  appState: string | null;
  gateOk: boolean;
  playing: boolean;
}

/**
 * watch — приложение на экране: следим за позицией и шлём ячейку по сокету;
 * heartbeat — фон и играет музыка: позиция не читается, HTTP-heartbeat продлевает последнюю ячейку;
 * idle — ничего не отправляем.
 */
export function publisherMode(i: PublisherInputs): PublisherMode {
  if (!i.onboarded) return 'idle';
  if (i.appState === 'background') return i.playing ? 'heartbeat' : 'idle';
  return i.gateOk ? 'watch' : 'idle';
}

export interface PlayingSnapshot {
  track: Track | null;
  playing: boolean;
  positionSec: number;
}

export function toTrackRef(track: Track | null): TrackRef | null {
  if (!track) return null;
  return { id: track.id, title: track.title, artist: track.artist, artworkUrl: track.artworkUrl, playback: track.playback };
}

function positionOf(np: PlayingSnapshot): number | null {
  if (!np.track || !Number.isFinite(np.positionSec)) return null;
  return Math.max(0, Math.round(np.positionSec * 10) / 10);
}

export function buildPresenceUpdate(cell: string, motion: Motion, approx: boolean, np: PlayingSnapshot): PresenceUpdate {
  return {
    cell,
    motion,
    approx,
    track: toTrackRef(np.track),
    playing: np.track !== null && np.playing,
    positionSec: positionOf(np),
  };
}

export function buildHeartbeat(np: PlayingSnapshot): PresenceHeartbeat {
  return { track: toTrackRef(np.track), playing: np.track !== null && np.playing, positionSec: positionOf(np) };
}

/** Что видно другим о треке; позиция сюда не входит — она уходит с очередным обновлением или heartbeat. */
export function playingKey(np: Pick<PlayingSnapshot, 'track' | 'playing'>): string {
  return `${np.track?.id ?? ''}|${np.track !== null && np.playing ? 1 : 0}`;
}

// ─── фиксы геолокации ────────────────────────────────────────────────────────

export interface FixState {
  cell: string | null;
  motion: Motion;
  /** В каком режиме получена ячейка: true — квартал приблизительной геолокации; нет поля — точный. */
  approx?: boolean;
}

export interface RawFix {
  latitude: number;
  longitude: number;
  accuracy: number | null | undefined;
  speed: number | null | undefined;
}

/**
 * Новый фикс → новая ячейка (с гистерезисом) и состояние движения.
 * approx — текущий режим геолокации (ok_approx в гейте).
 * changed — есть ли что отправить: координаты дальше этой функции не уходят.
 */
export function applyFix(prev: FixState, fix: RawFix, approx = false): { next: FixState; changed: boolean } {
  const accuracyM = fix.accuracy == null || !Number.isFinite(fix.accuracy) ? null : fix.accuracy;
  const prevApprox = prev.approx ?? false;
  // Пользователь включил или выключил точную геопозицию — гистерезис начинается заново:
  // иначе уточнение ждало бы захода вглубь соседней ячейки, а огрубление не наступило бы вовсе.
  const switched = prevApprox !== approx;
  const accepted = nextPresenceCell(switched ? null : prev.cell, { lat: fix.latitude, lng: fix.longitude, accuracyM }, { approx });

  let cell = prev.cell;
  let mode = prevApprox;
  if (accepted !== null) {
    cell = accepted;
    mode = approx;
  } else if (switched && approx && prev.cell !== null) {
    // Точную ячейку после отказа от точной геопозиции нельзя показывать ни минуты — огрубляем сразу,
    // даже если свежий грубый фикс отбракован. Обратный случай безопасен: квартал остаётся до точного фикса.
    cell = approxCellOf(prev.cell);
    mode = true;
  }

  // Движение без ячейки бессмысленно: пока первой ячейки нет, сохраняем «стоит».
  const motion = cell === null ? prev.motion : motionFromSpeed(fix.speed);
  const changed = cell !== null && (cell !== prev.cell || motion !== prev.motion || mode !== prevApprox);
  return { next: { cell, motion, approx: mode }, changed };
}

/**
 * Что можно отправить прямо сейчас. Между сменой режима и первым новым фиксом в памяти может
 * лежать точная ячейка — если пользователь уже в приблизительном режиме, отправляем её квартал.
 */
export function publishableFix(state: FixState, approxNow: boolean): { cell: string | null; motion: Motion; approx: boolean } {
  const approx = state.approx ?? false;
  if (state.cell !== null && approxNow && !approx) return { cell: approxCellOf(state.cell), motion: state.motion, approx: true };
  return { cell: state.cell, motion: state.motion, approx };
}

/** Что показывает разрешение на геолокацию прямо сейчас: точная, приблизительная или её больше нет. */
export type GateMode = 'precise' | 'approx' | 'lost';

export type BackgroundBeat =
  | { kind: 'beat' }
  /** Точную геопозицию выключили, пока приложение в фоне: заменить ячейку кварталом и отправить его. */
  | { kind: 'downgrade'; next: FixState }
  /** Нечего продлевать. */
  | { kind: 'skip' }
  /** Геолокацию отозвали: не продлеваем точку, пусть истечёт сама. */
  | { kind: 'stop' };

/**
 * Решение фонового heartbeat. Позицию в фоне мы не читаем, но режим разрешения проверяем:
 * heartbeat не должен месяцами продлевать точную ячейку человеку, который от точности отказался.
 */
export function backgroundBeat(state: FixState, gate: GateMode): BackgroundBeat {
  if (gate === 'lost') return { kind: 'stop' };
  if (state.cell === null) return { kind: 'skip' };
  if (gate === 'approx' && !(state.approx ?? false)) {
    return { kind: 'downgrade', next: { cell: approxCellOf(state.cell), motion: state.motion, approx: true } };
  }
  return { kind: 'beat' };
}

// ─── троттлинг ───────────────────────────────────────────────────────────────

export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Не чаще раза в intervalMs, но последнее состояние не теряется никогда:
 * новое значение вытесняет ожидающее, а не отбрасывается.
 * send возвращает false, если отправить сейчас нельзя (нет связи) — значение ждёт следующего drain().
 */
export class LatestThrottle<T> {
  private pending: T | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly intervalMs: number,
    private readonly send: (value: T) => boolean,
    private readonly clock: Clock = realClock,
  ) {}

  push(value: T): void {
    if (this.disposed) return;
    this.pending = value;
    this.drain();
  }

  /** Отправить ожидающее, как только позволит интервал (например, после восстановления связи). */
  drain(): void {
    if (this.disposed || this.pending === null || this.timer !== null) return;
    const wait = this.lastSentAt + this.intervalMs - this.clock.now();
    if (wait > 0) {
      this.timer = this.clock.setTimer(() => {
        this.timer = null;
        this.drain();
      }, wait);
      return;
    }
    const value = this.pending;
    if (this.send(value)) {
      if (this.pending === value) this.pending = null;
      this.lastSentAt = this.clock.now();
    }
  }

  /** Сервер отклонил значение (например, по лимиту): вернуть его в очередь, если новее ничего нет. */
  requeue(value: T): void {
    if (this.disposed) return;
    this.pending ??= value;
    this.drain();
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** Забрать ожидающее значение (например, отправить его другим каналом при уходе в фон). */
  takePending(): T | null {
    const value = this.pending;
    this.pending = null;
    this.cancelTimer();
    return value;
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
