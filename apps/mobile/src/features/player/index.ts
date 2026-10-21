// КОНТРАКТ плеера: экспорты и сигнатуры не меняются. Реализация — engine.ts (движок), queue.ts (очередь), state.ts (снимок).
import type { Track } from '@muzradar/shared';
import { controller, initEngine } from './controller';
import { nowPlayingStore, useNowPlayingStore } from './state';

/** Откуда собрана очередь — для заголовка плеера и статистики. */
export type QueueSource =
  | { kind: 'section'; id: string; title: string }
  | { kind: 'search'; query: string }
  | { kind: 'listen'; userId: string; name: string }
  | { kind: 'single' };

export interface NowPlaying {
  track: Track | null;
  playing: boolean;
  buffering: boolean;
  positionSec: number;
  durationSec: number;
  shuffle: boolean;
  source: QueueSource | null;
  queue: readonly Track[];
  index: number;
  error: string | null;
}

export interface PlayerController {
  /** Заменяет очередь и начинает с `startIndex`. */
  playQueue(tracks: readonly Track[], startIndex: number, source: QueueSource): Promise<void>;
  /** Загружает трек по id (свежая ссылка с сервера) и играет с позиции. */
  playTrackId(trackId: string, source: QueueSource, startAtSec?: number): Promise<void>;
  toggle(): void;
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seek(sec: number): void;
  setShuffle(on: boolean): void;
}

export const player: PlayerController = controller;

/** Снимок состояния вне React (публикация присутствия, heartbeat). */
export function getNowPlaying(): NowPlaying {
  return nowPlayingStore.getState();
}

export function subscribeNowPlaying(listener: (state: NowPlaying) => void): () => void {
  return nowPlayingStore.subscribe((state) => listener(state));
}

/** Селектор состояния в React. Можно вернуть объект — сравнение поверхностное. */
export function useNowPlaying<T>(selector: (state: NowPlaying) => T): T {
  return useNowPlayingStore(selector);
}

/** Настройка аудиосессии; вызывается один раз при старте (идемпотентно). */
export async function initPlayer(): Promise<void> {
  await initEngine();
}

export { MiniPlayer } from './MiniPlayer';
