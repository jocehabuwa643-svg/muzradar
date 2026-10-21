import type { PlayerController } from './index';

type Engine = typeof import('./engine');

let engineModule: Engine | null = null;

/**
 * expo-audio обращается к нативному модулю уже при импорте. Движок подключается при первом
 * обращении — на деле при старте, из initPlayer() в корневом layout, — а не при импорте контракта:
 * так снимок NowPlaying доступен тестам соседних модулей и фоновым задачам без нативного аудио.
 * Плеер при этом остаётся одним на модуль и живёт вне React.
 */
function engine(): Engine {
  engineModule ??= require('./engine') as Engine;
  return engineModule;
}

export const controller: PlayerController = {
  playQueue: (tracks, startIndex, source) => engine().playQueue(tracks, startIndex, source),
  playTrackId: (trackId, source, startAtSec) => engine().playTrackId(trackId, source, startAtSec),
  toggle: () => engine().toggle(),
  play: () => engine().play(),
  pause: () => engine().pause(),
  next: () => engine().next(),
  prev: () => engine().prev(),
  seek: (sec) => engine().seek(sec),
  setShuffle: (on) => engine().setShuffle(on),
};

export function initEngine(): Promise<void> {
  return engine().ensureAudioMode();
}
