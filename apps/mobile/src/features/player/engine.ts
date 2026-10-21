import type { Track } from '@muzradar/shared';
import {
  clearPreloadedSource,
  createAudioPlayer,
  preload,
  setAudioModeAsync,
  type AudioMetadata,
  type AudioStatus,
} from 'expo-audio';
import { Platform } from 'react-native';
import { audibleDurationSec, canStream } from '@/features/catalog/playable';
import { api } from '@/lib/api';
import { absoluteUrl } from '@/lib/config';
import type { NowPlaying, QueueSource } from './index';
import {
  currentTrack,
  decidePrev,
  nextQueue,
  orderedTracks,
  peekNext,
  queueStore,
  replaceQueue,
  setShuffleQueue,
  type QueueState,
} from './queue';
import { nowPlayingStore, patchNowPlaying } from './state';

/*
 * Движок воспроизведения. Один AudioPlayer на всё приложение, созданный при загрузке модуля,
 * и слушатель статуса вне React. Почему так (expo-audio 57):
 * - useAudioPlayer освобождает плеер при размонтировании, а Android размонтирует дерево в фоне —
 *   музыка обрывалась посреди трека (expo#49906);
 * - плеер на каждый трек течёт: примерно после 40 треков перестаёт приходить didJustFinish (expo#41852);
 * - next/prev на экране блокировки в 57 нет вовсе — очередь листает только JS.
 */

export const MAX_CONSECUTIVE_ERRORS = 3;
/** С этой доли трека подгружаем следующий, чтобы переход не ждал сеть. */
export const PRELOAD_AT = 0.8;
/** Android держит предзагрузку целиком в памяти — длинные записи (концерты, лекции) не тянем. */
const ANDROID_PRELOAD_MAX_SEC = 15 * 60;
/** После нашей команды плеер ещё какое-то время присылает прежнее состояние. */
const COMMAND_SETTLE_MS = 1_000;
const SEEK_SETTLE_MS = 800;
/** Пауза у самого конца — это конец трека, а не пауза пользователя. */
const END_TOLERANCE_SEC = 1.5;

export const PLAYER_ERRORS = {
  tooMany: 'Не получается включить треки. Проверьте интернет и попробуйте ещё раз.',
  track: 'Этот трек сейчас не воспроизводится.',
  fetch: 'Не удалось загрузить трек. Проверьте интернет.',
  unavailable: 'Этот трек сейчас недоступен.',
} as const;

const noop = () => undefined;

/** Адрес потока или null, если трек играть нельзя (недоступен, без ссылки, запрещённый источник). */
export function streamUri(track: Track): string | null {
  return canStream(track) ? absoluteUrl(track.streamUrl) : null;
}

export function isPlayable(track: Track): boolean {
  return streamUri(track) !== null;
}

// ─── состояние движка ────────────────────────────────────────────────────────

interface LoadState {
  /** Номер загрузки: статусы и ошибки прошлого трека не трогают новый. */
  id: number;
  track: Track | null;
  pendingSeekSec: number | null;
  /** Трек реально зазвучал — с этого момента пауза без нашей команды считается внешней. */
  started: boolean;
  finished: boolean;
  errored: boolean;
  preloadChecked: boolean;
}

function freshLoad(id: number, track: Track | null): LoadState {
  return { id, track, pendingSeekSec: null, started: false, finished: false, errored: false, preloadChecked: false };
}

let current: LoadState = freshLoad(0, null);
let lockScreenActive = false;
let intendPlaying = false;
let wasBuffering = false;
let consecutiveErrors = 0;
/** Последний запрос playQueue/playTrackId; более старые, завершившись позже, ничего не делают. */
let requestSeq = 0;
let lastCommandAt = 0;
let seekSettleUntil = 0;
let preloadedUri: string | null = null;
/** Android не отпускает предзагруженные байты сам: освобождаем, когда новый трек загрузился. */
let consumedPreloadUri: string | null = null;
let audioMode: Promise<void> | null = null;

const audio = createAudioPlayer(null, { updateInterval: 500 });

// ─── аудиосессия и экран блокировки ──────────────────────────────────────────

/** Режим аудиосессии — один раз за запуск; при сбое следующий вызов попробует снова. */
export function ensureAudioMode(): Promise<void> {
  audioMode ??= setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    // экран блокировки работает только в doNotMix
    interruptionMode: 'doNotMix',
    allowsRecording: false,
    shouldRouteThroughEarpiece: false,
  }).catch((err: unknown) => {
    audioMode = null;
    throw err;
  });
  return audioMode;
}

const ensureAudioModeQuietly = () => ensureAudioMode().catch(noop);

function metadataFor(track: Track): AudioMetadata {
  const meta: AudioMetadata = { title: track.title, artist: track.artist };
  if (track.album) meta.albumTitle = track.album;
  const art = absoluteUrl(track.artworkUrl);
  if (art) meta.artworkUrl = art;
  return meta;
}

function setIntent(on: boolean): void {
  intendPlaying = on;
  patchNowPlaying({ playing: on });
}

/**
 * Загружает трек в единственный плеер. Порядок важен:
 * replace → экран блокировки (включается один раз: в 57 на iOS каждый повторный вызов
 * добавляет ещё шесть обработчиков пульта, и одно нажатие на AirPods ставит паузу и тут же снимает) →
 * play(): после конца трека replace сам не возобновляет воспроизведение.
 */
export function load(track: Track, autoplay: boolean, startAtSec = 0): void {
  const uri = streamUri(track);
  if (!uri) throw new Error(`player: track ${track.id} is not playable`);

  current = freshLoad(current.id + 1, track);
  const startAt = startAtSec > 0 ? startAtSec : 0;
  if (startAt > 0) current.pendingSeekSec = startAt;
  wasBuffering = false;

  audio.replace({ uri, name: track.title });

  if (preloadedUri) {
    if (preloadedUri === uri) consumedPreloadUri = uri;
    else void clearPreloadedSource({ uri: preloadedUri }).catch(noop);
    preloadedUri = null;
  }

  const meta = metadataFor(track);
  if (!lockScreenActive) {
    audio.setActiveForLockScreen(true, meta, { showSeekForward: false, showSeekBackward: false });
    lockScreenActive = true;
  } else {
    audio.updateLockScreenMetadata(meta);
  }

  if (autoplay) {
    lastCommandAt = Date.now();
    audio.play();
  }
  setIntent(autoplay);
  patchNowPlaying({ positionSec: startAt, durationSec: audibleDurationSec(track), buffering: autoplay, error: null });
}

function tryLoad(track: Track, autoplay: boolean, startAtSec = 0): void {
  try {
    load(track, autoplay, startAtSec);
  } catch {
    current = { ...freshLoad(current.id + 1, track), errored: true };
    failCurrent(autoplay);
  }
}

/**
 * Следующий играбельный трек очереди. Недоступные и без ссылки пропускаются молча.
 * `record` — текущий трек звучал и попадает в историю для «назад».
 */
function advance(record: boolean, autoplay: boolean): boolean {
  let q = nextQueue(queueStore.getState(), record);
  while (q) {
    const track = currentTrack(q);
    if (track && isPlayable(track)) {
      queueStore.setState(q, true);
      tryLoad(track, autoplay);
      return true;
    }
    q = nextQueue(q, false);
  }
  return false;
}

function stopWithError(message: string): void {
  setIntent(false);
  try {
    audio.pause();
  } catch {
    // плеер уже в ошибке — ставить на паузу нечего
  }
  patchNowPlaying({ buffering: false, error: message });
}

function failCurrent(autoplay: boolean): void {
  consecutiveErrors += 1;
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    stopWithError(PLAYER_ERRORS.tooMany);
    return;
  }
  if (!advance(false, autoplay)) stopWithError(PLAYER_ERRORS.track);
}

/** Очередь кончилась: повтора в фазе 0 нет. Перематываем в начало, чтобы «играть» включало трек заново. */
function finishQueue(): void {
  setIntent(false);
  // на Android после конца трека playWhenReady остаётся true: без pause() перемотка снова запустит звук
  audio.pause();
  void audio.seekTo(0).catch(noop);
  current.finished = false;
  patchNowPlaying({ positionSec: 0, buffering: false });
}

// ─── статус плеера ───────────────────────────────────────────────────────────

function syncIntent(s: AudioStatus, cur: LoadState, now: number): void {
  const settled = now - lastCommandAt > COMMAND_SETTLE_MS;
  if (s.playing && s.isLoaded && !s.isBuffering) {
    cur.started = true;
    consecutiveErrors = 0;
    // включили с экрана блокировки, наушников или после звонка
    if (!intendPlaying && settled) setIntent(true);
    return;
  }
  const nearEnd = s.duration > 0 && s.currentTime >= s.duration - END_TOLERANCE_SEC;
  if (intendPlaying && settled && cur.started && s.isLoaded && !s.playing && !s.isBuffering && !s.didJustFinish && !nearEnd) {
    // пауза пришла не от нас: экран блокировки, отключённые наушники, звонок
    setIntent(false);
  }
}

/**
 * Android отдаёт аудиофокус на коротком ребуфере и сам его не возвращает (expo#50072):
 * музыка продолжает играть поверх звонков. Повторный play() снова запрашивает фокус.
 */
function reassertFocus(s: AudioStatus): void {
  if (Platform.OS === 'android' && wasBuffering && !s.isBuffering && s.playing && intendPlaying) audio.play();
  wasBuffering = s.isBuffering;
}

function maybePreload(s: AudioStatus, cur: LoadState): void {
  if (cur.preloadChecked || s.duration <= 0 || s.currentTime / s.duration < PRELOAD_AT) return;
  cur.preloadChecked = true;
  const next = peekNext(queueStore.getState(), isPlayable);
  const uri = next ? streamUri(next) : null;
  if (!next || !uri || uri === preloadedUri) return;
  if (Platform.OS === 'android' && audibleDurationSec(next) > ANDROID_PRELOAD_MAX_SEC) return;
  if (preloadedUri) void clearPreloadedSource({ uri: preloadedUri }).catch(noop);
  preloadedUri = uri;
  void preload({ uri, name: next.title }, { preferredForwardBufferDuration: 10 }).catch(() => {
    if (preloadedUri === uri) preloadedUri = null;
  });
}

function publish(s: AudioStatus, cur: LoadState, now: number): void {
  const patch: Partial<NowPlaying> = {
    buffering: intendPlaying && (s.isBuffering || !s.isLoaded),
    durationSec: s.duration > 0 ? s.duration : cur.track ? audibleDurationSec(cur.track) : 0,
  };
  // пока перемотка не применилась, плеер присылает старую позицию — ползунок не должен прыгать назад
  if (cur.pendingSeekSec === null && now >= seekSettleUntil) patch.positionSec = s.currentTime;
  patchNowPlaying(patch);
}

function onStatus(s: AudioStatus): void {
  const cur = current;
  if (!cur.track) return;

  if (s.error) {
    if (!cur.errored) {
      cur.errored = true;
      failCurrent(intendPlaying);
    }
    return;
  }
  const now = Date.now();

  if (s.isLoaded) {
    if (cur.pendingSeekSec !== null) {
      const at = cur.pendingSeekSec;
      cur.pendingSeekSec = null;
      seekSettleUntil = now + SEEK_SETTLE_MS;
      void audio.seekTo(at).catch(noop);
    }
    if (consumedPreloadUri) {
      if (Platform.OS === 'android') void clearPreloadedSource({ uri: consumedPreloadUri }).catch(noop);
      consumedPreloadUri = null;
    }
  }

  syncIntent(s, cur, now);
  reassertFocus(s);
  maybePreload(s, cur);
  publish(s, cur, now);

  if (s.didJustFinish && !cur.finished) {
    cur.finished = true;
    // трек доиграл до конца — значит, его слушали; следующий включаем всегда
    if (!advance(true, true)) finishQueue();
  }
}

// ─── команды ─────────────────────────────────────────────────────────────────

function clampStart(track: Track, sec: number): number {
  if (!(sec > 0)) return 0;
  const duration = audibleDurationSec(track);
  // почти у конца — начинаем сначала, иначе трек тут же кончится
  return duration > 0 && sec >= duration - 2 ? 0 : sec;
}

export async function playQueue(tracks: readonly Track[], startIndex: number, source: QueueSource): Promise<void> {
  const seq = ++requestSeq;
  await ensureAudioModeQuietly();
  if (seq !== requestSeq) return;

  let q: QueueState | null = replaceQueue(tracks, startIndex, queueStore.getState().shuffle);
  // выбранный трек может оказаться недоступным — начинаем с ближайшего играбельного после него
  while (q) {
    const t = currentTrack(q);
    if (t && isPlayable(t)) break;
    q = nextQueue(q, false);
  }
  const track = q ? currentTrack(q) : null;
  if (!q || !track) {
    patchNowPlaying({ error: PLAYER_ERRORS.unavailable });
    return;
  }

  consecutiveErrors = 0;
  patchNowPlaying({ source });
  queueStore.setState(q, true);
  tryLoad(track, true);
}

/** Свежая ссылка на поток с сервера — для «слушать вместе» и диплинков. */
export async function playTrackId(trackId: string, source: QueueSource, startAtSec = 0): Promise<void> {
  const seq = ++requestSeq;
  let track: Track;
  try {
    const [, fetched] = await Promise.all([ensureAudioModeQuietly(), api.track(trackId)]);
    track = fetched;
  } catch {
    if (seq === requestSeq) patchNowPlaying({ error: PLAYER_ERRORS.fetch });
    return;
  }
  if (seq !== requestSeq) return;
  if (!isPlayable(track)) {
    patchNowPlaying({ error: PLAYER_ERRORS.unavailable });
    return;
  }

  consecutiveErrors = 0;
  patchNowPlaying({ source });
  queueStore.setState(replaceQueue([track], 0, queueStore.getState().shuffle), true);
  tryLoad(track, true, clampStart(track, startAtSec));
}

export function play(): void {
  const track = currentTrack(queueStore.getState());
  if (!track) return;
  void ensureAudioModeQuietly();
  patchNowPlaying({ error: null });
  if (current.errored || current.track?.id !== track.id) {
    consecutiveErrors = 0;
    tryLoad(track, true);
    return;
  }
  current.finished = false;
  lastCommandAt = Date.now();
  audio.play();
  setIntent(true);
}

export function pause(): void {
  if (!current.track) return;
  lastCommandAt = Date.now();
  audio.pause();
  setIntent(false);
}

export function toggle(): void {
  if (intendPlaying) pause();
  else play();
}

/** Кнопка «дальше». В конце очереди ничего не делает — кнопка там неактивна. */
export function next(): void {
  consecutiveErrors = 0;
  advance(true, intendPlaying);
}

/** «Назад»: в первые секунды — предыдущий трек, позже — начало текущего. */
export function prev(): void {
  const q = queueStore.getState();
  if (!currentTrack(q)) return;
  consecutiveErrors = 0;
  const decision = decidePrev(q, nowPlayingStore.getState().positionSec, isPlayable);
  if (decision.kind === 'restart') {
    seek(0);
    return;
  }
  queueStore.setState(decision.state, true);
  const track = currentTrack(decision.state);
  if (track) tryLoad(track, intendPlaying);
}

export function seek(sec: number): void {
  const cur = current;
  if (!cur.track || !Number.isFinite(sec)) return;
  const duration = nowPlayingStore.getState().durationSec;
  const at = Math.max(0, duration > 0 ? Math.min(sec, duration) : sec);
  cur.finished = false;
  seekSettleUntil = Date.now() + SEEK_SETTLE_MS;
  patchNowPlaying({ positionSec: at });
  if (cur.pendingSeekSec !== null || !audio.isLoaded) {
    cur.pendingSeekSec = at;
    return;
  }
  void audio.seekTo(at).catch(noop);
}

export function setShuffle(on: boolean): void {
  queueStore.setState(setShuffleQueue(queueStore.getState(), on), true);
  // следующий трек сменился — предзагрузку считаем заново
  current.preloadChecked = false;
}

// ─── подписки уровня модуля ──────────────────────────────────────────────────

queueStore.subscribe((q) => {
  patchNowPlaying({ track: currentTrack(q), queue: orderedTracks(q), index: q.index, shuffle: q.shuffle });
});

audio.addListener('playbackStatusUpdate', onStatus);
