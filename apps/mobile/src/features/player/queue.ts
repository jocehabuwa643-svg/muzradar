import type { Track } from '@muzradar/shared';
import { createStore } from 'zustand/vanilla';

/**
 * Очередь живёт в JS и не зависит от React: на Android дерево компонентов
 * размонтируется в фоне, а переключение треков должно продолжаться.
 */
export interface QueueState {
  tracks: readonly Track[];
  /** Порядок воспроизведения — индексы в `tracks`. */
  order: readonly number[];
  /** Позиция текущего трека в `order`; -1 — очередь пуста. */
  index: number;
  shuffle: boolean;
  /** Индексы `tracks`, которые реально звучали до текущего, — для «назад». */
  history: readonly number[];
}

/** «Назад» в первые секунды трека — предыдущий трек, позже — начало текущего. */
export const PREV_RESTART_AFTER_SEC = 3;

const HISTORY_LIMIT = 200;

export const EMPTY_QUEUE: QueueState = { tracks: [], order: [], index: -1, shuffle: false, history: [] };

export type RandomFn = () => number;

function identity(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** Перемешивание Фишера — Йетса; первым идёт `first`, чтобы текущий трек не прерывался. */
export function shuffledOrder(n: number, first: number, random: RandomFn = Math.random): number[] {
  const rest = identity(n).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = rest[i]!;
    rest[i] = rest[j]!;
    rest[j] = tmp;
  }
  return first >= 0 && first < n ? [first, ...rest] : rest;
}

export function currentTrackIndex(s: QueueState): number {
  return s.index >= 0 ? (s.order[s.index] ?? -1) : -1;
}

export function currentTrack(s: QueueState): Track | null {
  const i = currentTrackIndex(s);
  return i >= 0 ? (s.tracks[i] ?? null) : null;
}

/** Треки в порядке воспроизведения — для экрана и снимка NowPlaying. */
export function orderedTracks(s: QueueState): Track[] {
  return s.order.map((i) => s.tracks[i]).filter((t): t is Track => t !== undefined);
}

/** Новая очередь. Старая история не переносится: это другой контекст прослушивания. */
export function replaceQueue(tracks: readonly Track[], startIndex: number, shuffle: boolean, random: RandomFn = Math.random): QueueState {
  if (tracks.length === 0) return { ...EMPTY_QUEUE, shuffle };
  const start = Math.min(Math.max(0, Math.trunc(startIndex)), tracks.length - 1);
  const order = shuffle ? shuffledOrder(tracks.length, start, random) : identity(tracks.length);
  return { tracks, order, index: shuffle ? 0 : start, shuffle, history: [] };
}

function pushHistory(history: readonly number[], trackIndex: number): readonly number[] {
  if (trackIndex < 0) return history;
  const next = [...history, trackIndex];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/**
 * Следующий трек или null в конце очереди (повтора в фазе 0 нет).
 * `record = false` — текущий трек не звучал (ошибка, пропуск), в историю его не пишем.
 */
export function nextQueue(s: QueueState, record = true): QueueState | null {
  if (s.index < 0 || s.index + 1 >= s.order.length) return null;
  return {
    ...s,
    index: s.index + 1,
    history: record ? pushHistory(s.history, currentTrackIndex(s)) : s.history,
  };
}

/** Предыдущий трек: сначала по истории, без неё — по порядку. null — назад некуда. */
export function prevQueue(s: QueueState): QueueState | null {
  if (s.index < 0) return null;
  const last = s.history[s.history.length - 1];
  if (last !== undefined) {
    const pos = s.order.indexOf(last);
    if (pos >= 0) return { ...s, index: pos, history: s.history.slice(0, -1) };
    // трека из истории нет в порядке (не бывает при целой очереди) — выбрасываем запись
    return prevQueue({ ...s, history: s.history.slice(0, -1) });
  }
  if (s.index === 0) return null;
  return { ...s, index: s.index - 1 };
}

export type PrevDecision = { kind: 'restart' } | { kind: 'track'; state: QueueState };

export function decidePrev(s: QueueState, positionSec: number, isPlayable: (t: Track) => boolean = () => true): PrevDecision {
  if (positionSec >= PREV_RESTART_AFTER_SEC) return { kind: 'restart' };
  let prev = prevQueue(s);
  while (prev) {
    const t = currentTrack(prev);
    if (t && isPlayable(t)) return { kind: 'track', state: prev };
    prev = prevQueue(prev);
  }
  return { kind: 'restart' };
}

/**
 * Включение перемешивания: текущий трек встаёт первым, остальные — случайно.
 * Выключение: исходный порядок с позиции текущего трека. История сохраняется.
 */
export function setShuffleQueue(s: QueueState, on: boolean, random: RandomFn = Math.random): QueueState {
  if (s.shuffle === on) return s;
  const cur = currentTrackIndex(s);
  if (s.tracks.length === 0 || cur < 0) return { ...s, shuffle: on };
  if (on) return { ...s, shuffle: true, order: shuffledOrder(s.tracks.length, cur, random), index: 0 };
  return { ...s, shuffle: false, order: identity(s.tracks.length), index: cur };
}

/** Подменяет данные текущего трека (свежая ссылка на поток). */
export function updateCurrentTrack(s: QueueState, track: Track): QueueState {
  const cur = currentTrackIndex(s);
  if (cur < 0) return s;
  const tracks = s.tracks.slice();
  tracks[cur] = track;
  return { ...s, tracks };
}

/** Ближайший следующий трек, который можно играть, — для предзагрузки. */
export function peekNext(s: QueueState, isPlayable: (t: Track) => boolean = () => true): Track | null {
  for (let i = s.index + 1; i < s.order.length && s.index >= 0; i++) {
    const t = s.tracks[s.order[i] ?? -1];
    if (t && isPlayable(t)) return t;
  }
  return null;
}

export const queueStore = createStore<QueueState>()(() => EMPTY_QUEUE);
