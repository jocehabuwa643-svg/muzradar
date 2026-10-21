import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import type { NowPlaying } from './index';

export const IDLE_NOW_PLAYING: NowPlaying = {
  track: null,
  playing: false,
  buffering: false,
  positionSec: 0,
  durationSec: 0,
  shuffle: false,
  source: null,
  queue: [],
  index: -1,
  error: null,
};

/**
 * Снимок плеера вне React: его читают публикация присутствия и heartbeat из фона,
 * когда дерево компонентов на Android уже размонтировано.
 */
export const nowPlayingStore = createStore<NowPlaying>()(() => IDLE_NOW_PLAYING);

/** Меняет только то, что действительно изменилось: подписчики не дёргаются каждые 500 мс впустую. */
export function patchNowPlaying(patch: Partial<NowPlaying>): void {
  const prev = nowPlayingStore.getState();
  let changed = false;
  for (const key of Object.keys(patch) as (keyof NowPlaying)[]) {
    if (!Object.is(prev[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (changed) nowPlayingStore.setState(patch);
}

/** Селектор может вернуть объект или массив — сравнение поверхностное, лишних рендеров нет. */
export function useNowPlayingStore<T>(selector: (state: NowPlaying) => T): T {
  return useStore(nowPlayingStore, useShallow(selector));
}
