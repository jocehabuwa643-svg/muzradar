import type { Track } from '@muzradar/shared';
import type { AudioStatus } from 'expo-audio';
import { makeTrack, tracks } from '../__fixtures__/tracks';

// Фейковый AudioPlayer: пишет журнал вызовов и раздаёт статусы подписчикам, как нативный модуль.
jest.mock('expo-audio', () => {
  class FakeAudioPlayer {
    calls: string[] = [];
    listeners: ((status: unknown) => void)[] = [];
    isLoaded = false;
    replace = jest.fn((source: { uri: string }) => {
      this.calls.push(`replace:${source.uri}`);
      this.isLoaded = false;
    });
    play = jest.fn(() => {
      this.calls.push('play');
    });
    pause = jest.fn(() => {
      this.calls.push('pause');
    });
    seekTo = jest.fn((sec: number) => {
      this.calls.push(`seek:${sec}`);
      return Promise.resolve();
    });
    setActiveForLockScreen = jest.fn();
    updateLockScreenMetadata = jest.fn();
    addListener = jest.fn((event: string, listener: (status: unknown) => void) => {
      if (event === 'playbackStatusUpdate') this.listeners.push(listener);
      return { remove: () => undefined };
    });
    emit(partial: Record<string, unknown>) {
      const status = {
        id: 'p1',
        currentTime: 0,
        playbackState: 'ready',
        timeControlStatus: 'paused',
        reasonForWaitingToPlay: '',
        mute: false,
        duration: 0,
        playing: false,
        loop: false,
        didJustFinish: false,
        isBuffering: false,
        isLoaded: false,
        playbackRate: 1,
        shouldCorrectPitch: true,
        isLive: false,
        currentOffsetFromLive: null,
        error: null,
        ...partial,
      };
      if (status.isLoaded) this.isLoaded = true;
      for (const l of this.listeners) l(status);
    }
  }
  return {
    createAudioPlayer: jest.fn(() => new FakeAudioPlayer()),
    preload: jest.fn(() => Promise.resolve()),
    clearPreloadedSource: jest.fn(() => Promise.resolve()),
    setAudioModeAsync: jest.fn(() => Promise.resolve()),
  };
});

jest.mock('@/lib/api', () => ({ api: { track: jest.fn() } }));

interface FakePlayer {
  calls: string[];
  isLoaded: boolean;
  replace: jest.Mock;
  play: jest.Mock;
  pause: jest.Mock;
  seekTo: jest.Mock;
  setActiveForLockScreen: jest.Mock;
  updateLockScreenMetadata: jest.Mock;
  addListener: jest.Mock;
  emit(partial: Partial<AudioStatus>): void;
}

type EngineModule = typeof import('../engine');

function setup() {
  jest.resetModules();
  const audioModule = jest.requireMock('expo-audio') as {
    createAudioPlayer: jest.Mock;
    preload: jest.Mock;
    clearPreloadedSource: jest.Mock;
    setAudioModeAsync: jest.Mock;
  };
  const engine = require('../engine') as EngineModule;
  const { nowPlayingStore } = require('../state') as typeof import('../state');
  const { api } = jest.requireMock('@/lib/api') as { api: { track: jest.Mock } };
  const { absoluteUrl } = require('@/lib/config') as typeof import('@/lib/config');
  expect(audioModule.createAudioPlayer).toHaveBeenCalledTimes(1);
  const audio = audioModule.createAudioPlayer.mock.results[0]!.value as FakePlayer;
  return { engine, audio, audioModule, api, absoluteUrl, now: () => nowPlayingStore.getState() };
}

const SECTION = { kind: 'section', id: 'new', title: 'Новое' } as const;

/** Трек зазвучал и доиграл до конца. */
function playThrough(audio: FakePlayer, duration = 200) {
  audio.emit({ isLoaded: true, playing: true, duration, currentTime: 5 });
  audio.emit({ isLoaded: true, playing: false, duration, currentTime: duration, didJustFinish: true });
}

const uri = (t: Track) => t.streamUrl!;

describe('движок плеера', () => {
  let dateNow: jest.SpyInstance<number, []>;
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    dateNow = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => dateNow.mockRestore());

  it('создаёт один плеер при загрузке модуля и настраивает аудиосессию один раз', async () => {
    const { engine, audioModule } = setup();
    expect(audioModule.createAudioPlayer).toHaveBeenCalledWith(null, { updateInterval: 500 });
    await engine.ensureAudioMode();
    await engine.ensureAudioMode();
    await engine.playQueue(tracks(1), 0, SECTION);
    expect(audioModule.setAudioModeAsync).toHaveBeenCalledTimes(1);
    expect(audioModule.setAudioModeAsync).toHaveBeenCalledWith({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    });
  });

  it('экран блокировки включается ровно один раз на три загрузки, дальше — только метаданные', async () => {
    const { engine, audio } = setup();
    const list = tracks(1, 2, 3);
    await engine.playQueue(list, 0, SECTION);
    playThrough(audio);
    playThrough(audio);

    expect(audio.replace).toHaveBeenCalledTimes(3);
    expect(audio.setActiveForLockScreen).toHaveBeenCalledTimes(1);
    expect(audio.setActiveForLockScreen).toHaveBeenCalledWith(
      true,
      { title: 'Трек 1', artist: 'Артист 1', artworkUrl: 'https://img.test/1.jpg' },
      { showSeekForward: false, showSeekBackward: false },
    );
    // сначала replace, потом экран блокировки
    expect(audio.replace.mock.invocationCallOrder[0]!).toBeLessThan(audio.setActiveForLockScreen.mock.invocationCallOrder[0]!);
    expect(audio.updateLockScreenMetadata).toHaveBeenCalledTimes(2);
    expect(audio.updateLockScreenMetadata.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['Трек 2', 'Трек 3']);
  });

  it('при автопереходе play() идёт после каждого replace(), без pause() между треками', async () => {
    const { engine, audio } = setup();
    const list = tracks(1, 2, 3);
    await engine.playQueue(list, 0, SECTION);
    playThrough(audio);
    playThrough(audio);

    expect(audio.calls.slice(0, 6)).toEqual([
      `replace:${uri(list[0]!)}`,
      'play',
      `replace:${uri(list[1]!)}`,
      'play',
      `replace:${uri(list[2]!)}`,
      'play',
    ]);
  });

  it('didJustFinish переключает на следующий трек, в конце очереди — остановка', async () => {
    const { engine, audio, now } = setup();
    const list = tracks(1, 2);
    await engine.playQueue(list, 0, SECTION);
    expect(now().track?.id).toBe('audius:t1');
    expect(now().playing).toBe(true);
    expect(now().source).toEqual(SECTION);

    playThrough(audio);
    expect(now().track?.id).toBe('audius:t2');
    expect(now().index).toBe(1);
    expect(now().playing).toBe(true);

    audio.calls.length = 0;
    playThrough(audio);
    // повтора нет: пауза и перемотка в начало последнего трека
    expect(audio.replace).toHaveBeenCalledTimes(2);
    expect(audio.calls).toEqual(['pause', 'seek:0']);
    expect(now().track?.id).toBe('audius:t2');
    expect(now().playing).toBe(false);
    expect(now().positionSec).toBe(0);
  });

  it('ошибка трека — переход к следующему; после 3 ошибок подряд — остановка с сообщением', async () => {
    const { engine, audio, now } = setup();
    const list = tracks(1, 2, 3, 4, 5);
    await engine.playQueue(list, 0, SECTION);

    audio.emit({ error: 'Source error' });
    expect(now().track?.id).toBe('audius:t2');
    audio.emit({ error: 'Source error' });
    expect(now().track?.id).toBe('audius:t3');
    audio.emit({ error: 'Source error' });
    // после остановки повтор ошибки той же загрузки ничего не делает
    audio.emit({ error: 'Source error' });

    expect(audio.replace).toHaveBeenCalledTimes(3);
    expect(now().track?.id).toBe('audius:t3');
    expect(now().playing).toBe(false);
    expect(now().error).toBe(engine.PLAYER_ERRORS.tooMany);
    expect(audio.pause).toHaveBeenCalled();
  });

  it('трек, который зазвучал, сбрасывает счётчик ошибок', async () => {
    const { engine, audio, now } = setup();
    await engine.playQueue(tracks(1, 2, 3, 4, 5), 0, SECTION);
    audio.emit({ error: 'e' }); // 1 → трек 2
    audio.emit({ error: 'e' }); // 2 → трек 3
    audio.emit({ isLoaded: true, playing: true, duration: 200, currentTime: 3 }); // трек 3 играет
    audio.emit({ error: 'e' }); // 1 → трек 4
    audio.emit({ error: 'e' }); // 2 → трек 5
    expect(now().track?.id).toBe('audius:t5');
    expect(now().error).toBeNull();
  });

  it('недоступные, без ссылки и из запрещённых источников треки пропускаются', async () => {
    const { engine, audio, now } = setup();
    const list = [
      makeTrack(1, { playback: 'unavailable' }),
      makeTrack(2, { streamUrl: null }),
      makeTrack(3),
      makeTrack(4, { provider: 'deezer', id: 'deezer:4' }),
      makeTrack(5, { provider: 'itunes', id: 'itunes:5', playback: 'preview' }),
      makeTrack(6),
    ];
    await engine.playQueue(list, 0, SECTION);
    expect(audio.replace).toHaveBeenCalledTimes(1);
    expect(audio.replace).toHaveBeenLastCalledWith({ uri: uri(list[2]!), name: 'Трек 3' });
    expect(now().track?.id).toBe('audius:t3');

    playThrough(audio);
    expect(audio.replace).toHaveBeenCalledTimes(2);
    expect(audio.replace).toHaveBeenLastCalledWith({ uri: uri(list[5]!), name: 'Трек 6' });
    expect(now().error).toBeNull();
  });

  it('если играть нечего, текущая очередь не трогается', async () => {
    const { engine, audio, now } = setup();
    await engine.playQueue(tracks(1), 0, SECTION);
    await engine.playQueue([makeTrack(9, { playback: 'unavailable' })], 0, SECTION);
    expect(audio.replace).toHaveBeenCalledTimes(1);
    expect(now().track?.id).toBe('audius:t1');
    expect(now().error).toBe(engine.PLAYER_ERRORS.unavailable);
  });

  it('относительная ссылка на поток дополняется адресом API', async () => {
    const { engine, audio, absoluteUrl } = setup();
    await engine.playQueue([makeTrack(1, { streamUrl: '/v1/catalog/tracks/audius%3At1/stream' })], 0, SECTION);
    expect(audio.replace).toHaveBeenCalledWith({ uri: absoluteUrl('/v1/catalog/tracks/audius%3At1/stream'), name: 'Трек 1' });
    expect((audio.replace.mock.calls[0]![0] as { uri: string }).uri).toMatch(/^https?:\/\//);
  });

  it('playTrackId берёт трек через api.track и перематывает на startAtSec после загрузки', async () => {
    const { engine, audio, api, now } = setup();
    const t = makeTrack(7);
    api.track.mockResolvedValue(t);
    const source = { kind: 'listen', userId: 'u_aaaaaaaaaaaaaaaaaaaa', name: 'Маша' } as const;

    await engine.playTrackId('audius:t7', source, 42);

    expect(api.track).toHaveBeenCalledWith('audius:t7');
    expect(audio.replace).toHaveBeenCalledWith({ uri: uri(t), name: 'Трек 7' });
    expect(audio.play).toHaveBeenCalled();
    expect(audio.seekTo).not.toHaveBeenCalled();
    expect(now().positionSec).toBe(42);
    expect(now().source).toEqual(source);
    expect(now().queue.map((q) => q.id)).toEqual(['audius:t7']);

    // статус до загрузки не должен сбить позицию
    audio.emit({ isLoaded: false, isBuffering: true, playing: true, currentTime: 0 });
    expect(now().positionSec).toBe(42);

    audio.emit({ isLoaded: true, duration: 200, currentTime: 0 });
    expect(audio.seekTo).toHaveBeenCalledTimes(1);
    expect(audio.seekTo).toHaveBeenCalledWith(42);
    audio.emit({ isLoaded: true, playing: true, duration: 200, currentTime: 42.5 });
    expect(audio.seekTo).toHaveBeenCalledTimes(1);
  });

  it('playTrackId: ошибка сети — сообщение, плеер не трогается; устаревший ответ игнорируется', async () => {
    const { engine, audio, api, now } = setup();
    api.track.mockRejectedValueOnce(new Error('offline'));
    await engine.playTrackId('audius:t1', { kind: 'single' });
    expect(audio.replace).not.toHaveBeenCalled();
    expect(now().error).toBe(engine.PLAYER_ERRORS.fetch);

    let resolveSlow: (t: Track) => void = () => undefined;
    api.track.mockImplementationOnce(() => new Promise<Track>((r) => (resolveSlow = r)));
    const slow = engine.playTrackId('audius:t1', { kind: 'single' });
    await engine.playQueue(tracks(2), 0, SECTION);
    resolveSlow(makeTrack(1));
    await slow;
    expect(audio.replace).toHaveBeenCalledTimes(1);
    expect(now().track?.id).toBe('audius:t2');
  });

  it('«назад»: в первые 3 с — предыдущий трек, позже — начало текущего', async () => {
    const { engine, audio, now } = setup();
    const list = tracks(1, 2);
    await engine.playQueue(list, 0, SECTION);
    playThrough(audio);
    expect(now().track?.id).toBe('audius:t2');

    audio.emit({ isLoaded: true, playing: true, duration: 200, currentTime: 12 });
    clock += 5_000;
    audio.emit({ isLoaded: true, playing: true, duration: 200, currentTime: 13 });
    engine.prev();
    expect(audio.seekTo).toHaveBeenLastCalledWith(0);
    expect(now().track?.id).toBe('audius:t2');

    clock += 5_000;
    audio.emit({ isLoaded: true, playing: true, duration: 200, currentTime: 1 });
    engine.prev();
    expect(now().track?.id).toBe('audius:t1');
    expect(audio.replace).toHaveBeenLastCalledWith({ uri: uri(list[0]!), name: 'Трек 1' });
    expect(audio.play).toHaveBeenCalledTimes(3);
  });

  it('пауза с экрана блокировки отражается в состоянии, play с него — тоже', async () => {
    const { engine, audio, now } = setup();
    await engine.playQueue(tracks(1, 2), 0, SECTION);
    audio.emit({ isLoaded: true, playing: true, duration: 200, currentTime: 10 });
    clock += 5_000;
    audio.emit({ isLoaded: true, playing: false, duration: 200, currentTime: 11 });
    expect(now().playing).toBe(false);

    clock += 5_000;
    audio.emit({ isLoaded: true, playing: true, duration: 200, currentTime: 11 });
    expect(now().playing).toBe(true);
    // сам движок при этом play()/pause() не вызывал
    expect(audio.calls).toEqual([`replace:https://stream.test/1.mp3`, 'play']);
  });

  it('toggle ставит на паузу и продолжает тот же трек без перезагрузки', async () => {
    const { engine, audio, now } = setup();
    await engine.playQueue(tracks(1), 0, SECTION);
    engine.toggle();
    expect(now().playing).toBe(false);
    engine.toggle();
    expect(now().playing).toBe(true);
    expect(audio.calls).toEqual([`replace:https://stream.test/1.mp3`, 'play', 'pause', 'play']);
  });

  it('около 80 % трека подгружается следующий играбельный', async () => {
    const { engine, audio, audioModule } = setup();
    const list = [makeTrack(1), makeTrack(2, { streamUrl: null }), makeTrack(3)];
    await engine.playQueue(list, 0, SECTION);
    audio.emit({ isLoaded: true, playing: true, duration: 100, currentTime: 50 });
    expect(audioModule.preload).not.toHaveBeenCalled();
    audio.emit({ isLoaded: true, playing: true, duration: 100, currentTime: 81 });
    audio.emit({ isLoaded: true, playing: true, duration: 100, currentTime: 82 });
    expect(audioModule.preload).toHaveBeenCalledTimes(1);
    expect(audioModule.preload).toHaveBeenCalledWith({ uri: uri(list[2]!), name: 'Трек 3' }, { preferredForwardBufferDuration: 10 });
  });

  it('перемотка до загрузки откладывается и применяется, когда трек загрузился', async () => {
    const { engine, audio, now } = setup();
    await engine.playQueue(tracks(1), 0, SECTION);
    engine.seek(30);
    expect(audio.seekTo).not.toHaveBeenCalled();
    expect(now().positionSec).toBe(30);
    audio.emit({ isLoaded: true, duration: 200, currentTime: 0 });
    expect(audio.seekTo).toHaveBeenCalledWith(30);
  });
});

describe('контракт @/features/player', () => {
  it('player и снимок NowPlaying работают через публичный модуль', async () => {
    jest.resetModules();
    const mod = require('../index') as typeof import('../index');
    const audioModule = jest.requireMock('expo-audio') as { createAudioPlayer: jest.Mock };
    // движок подключается лениво, а не при импорте контракта
    expect(audioModule.createAudioPlayer).not.toHaveBeenCalled();
    expect(mod.getNowPlaying().track).toBeNull();

    const seen: (string | null)[] = [];
    const unsubscribe = mod.subscribeNowPlaying((s) => seen.push(s.track?.id ?? null));
    await mod.initPlayer();
    await mod.initPlayer();
    await mod.player.playQueue(tracks(1, 2), 1, SECTION);
    unsubscribe();

    expect(audioModule.createAudioPlayer).toHaveBeenCalledTimes(1);
    expect(mod.getNowPlaying().track?.id).toBe('audius:t2');
    expect(seen).toContain('audius:t2');
  });
});
