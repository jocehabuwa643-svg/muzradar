import { approxCell, encodeGeohash, type PresenceUpdate } from '@muzradar/shared';
import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

// Публикатор целиком: настоящие logic/cell/session, подменены только границы — геолокация, разрешение, сокет, плеер.
const mockState: { onFix: ((loc: unknown) => void) | null; gate: string } = { onFix: null, gate: 'ok_approx' };
const mockSocket = { connected: true, on: jest.fn(), off: jest.fn() };
const mockEmitAck = jest.fn((..._args: unknown[]) => Promise.resolve(null));
const mockNp = { track: null as null | { id: string; title: string; artist: string; artworkUrl: null; playback: 'full' }, playing: false, positionSec: 0 };

jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  watchPositionAsync: jest.fn((_options: unknown, cb: (loc: unknown) => void) => {
    mockState.onFix = cb;
    return Promise.resolve({ remove: jest.fn() });
  }),
}));
jest.mock('@/features/location/gate', () => ({
  // Гейт не ужесточается: приблизительная геолокация — такой же валидный вход, как точная
  useLocationGate: () => ({ state: mockState.gate, ok: true, approx: mockState.gate === 'ok_approx', recheck: jest.fn(), resolve: jest.fn() }),
  // Свежее чтение разрешения (без координат) — им публикатор подтверждает режим
  readLocationGate: jest.fn(() => Promise.resolve(mockState.gate)),
}));
jest.mock('@/features/player', () => ({
  getNowPlaying: () => mockNp,
  subscribeNowPlaying: () => () => undefined,
  useNowPlaying: (select: (s: typeof mockNp) => unknown) => select(mockNp),
}));
jest.mock('@/lib/realtime', () => ({
  getRealtime: () => mockSocket,
  emitAck: (...args: unknown[]) => mockEmitAck(...args),
}));
jest.mock('@/lib/api', () => ({
  api: { presenceUpdate: jest.fn(() => Promise.resolve()), heartbeat: jest.fn(() => Promise.resolve()) },
}));

import { api } from '@/lib/api';
import { useSession } from '@/state/session';
import { getFixState, resetFixState, setFixState } from '../cell';
import { usePresencePublisher } from '../index';

const HERE = { latitude: 55.7558, longitude: 37.6176 };
const PRECISE = encodeGeohash(HERE.latitude, HERE.longitude, 7);
const ZONE = approxCell(HERE.latitude, HERE.longitude);
const STEP_MS = 5_000; // PRESENCE.minIntervalMs: между отправками троттлинг ждёт столько
const mockedApi = api as jest.Mocked<typeof api>;

function sentUpdates(): PresenceUpdate[] {
  return mockEmitAck.mock.calls.filter((c) => c[0] === 'presence:update').map((c) => c[1] as PresenceUpdate);
}

function fix(accuracy: number) {
  act(() => mockState.onFix?.({ coords: { ...HERE, accuracy, speed: 0 } }));
}

function advance() {
  act(() => {
    jest.advanceTimersByTime(STEP_MS);
  });
}

/** Дождаться, пока публикатор перечитает разрешение и подтвердит режим. */
async function confirmMode() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setAppState(state: string) {
  Object.defineProperty(AppState, 'currentState', { value: state, configurable: true, writable: true });
}

describe('публикатор присутствия: оба режима через живой сокет', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetFixState();
    setAppState('active');
    mockState.onFix = null;
    mockState.gate = 'ok_approx';
    mockNp.track = null;
    mockNp.playing = false;
    mockEmitAck.mockClear();
    mockSocket.on.mockClear();
    mockSocket.off.mockClear();
    mockedApi.presenceUpdate.mockClear();
    mockedApi.heartbeat.mockClear();
    useSession.setState({ onboardedAt: '2026-09-23T00:00:00.000Z', locationGranted: true, locationApprox: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    setAppState('active');
  });

  it('approx-пользователь публикуется, а после включения точной геопозиции ячейка сужается по тому же сокету', async () => {
    const { unmount } = renderHook(() => usePresencePublisher());
    await confirmMode();
    expect(mockState.onFix).not.toBeNull();

    fix(2000);
    expect(sentUpdates().at(-1)).toMatchObject({ approx: true, cell: ZONE });

    mockState.gate = 'ok';
    act(() => useSession.setState({ locationApprox: false }));
    advance();
    fix(30);
    advance();

    expect(sentUpdates().at(-1)).toMatchObject({ approx: false, cell: PRECISE });
    // Сокет тот же и подписка не снималась: переключение режима не рвёт реалтайм
    expect(mockSocket.on).toHaveBeenCalledTimes(1);
    expect(mockSocket.off).not.toHaveBeenCalled();

    unmount();
    expect(mockSocket.off).toHaveBeenCalledWith('connect', expect.any(Function));
  });

  it('выключили точную геопозицию на экране: квартал уходит без ожидания нового фикса', async () => {
    mockState.gate = 'ok';
    useSession.setState({ locationApprox: false });
    renderHook(() => usePresencePublisher());
    await confirmMode();

    fix(30);
    expect(sentUpdates().at(-1)).toMatchObject({ approx: false, cell: PRECISE });

    mockState.gate = 'ok_approx';
    act(() => useSession.setState({ locationApprox: true }));
    advance();

    expect(sentUpdates().at(-1)).toMatchObject({ approx: true, cell: ZONE });
  });

  it('возврат из настроек: пока режим не перечитан, не уходит ничего; старая точная ячейка не утекает', async () => {
    // В памяти — точная ячейка из прошлого сеанса, в сессии — ещё «точный», а разрешение уже приблизительное
    setFixState({ cell: PRECISE, motion: 'still', approx: false });
    useSession.setState({ locationApprox: false });
    mockState.gate = 'ok_approx';

    renderHook(() => usePresencePublisher());
    // сокет переподключается сразу после возврата — раньше, чем гейт перечитает разрешение
    const onConnect = mockSocket.on.mock.calls.find((c) => c[0] === 'connect')?.[1] as () => void;
    act(() => onConnect());
    // до подтверждения режима — тишина, даже если пришёл фикс
    fix(30);
    expect(sentUpdates()).toEqual([]);

    await confirmMode();
    const sent = sentUpdates();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.at(-1)).toMatchObject({ approx: true, cell: ZONE });
    expect(sent.some((u) => u.cell === PRECISE)).toBe(false);
    expect(useSession.getState().locationApprox).toBe(true);
  });

  it('первый грубый фикс хуже 500 м больше не глушит публикацию', async () => {
    renderHook(() => usePresencePublisher());
    await confirmMode();
    fix(2800);
    expect(sentUpdates()).toHaveLength(1);
  });

  it('фон + музыка: точную геопозицию выключили — heartbeat не продлевает точную ячейку, а отправляет квартал', async () => {
    setFixState({ cell: PRECISE, motion: 'still', approx: false });
    useSession.setState({ locationApprox: false });
    mockNp.track = { id: 'audius:1', title: 'Ночь', artist: 'Кино', artworkUrl: null, playback: 'full' };
    mockNp.playing = true;
    setAppState('background');
    mockState.gate = 'ok_approx';

    renderHook(() => usePresencePublisher());
    await confirmMode();

    expect(mockedApi.heartbeat).not.toHaveBeenCalled();
    expect(mockedApi.presenceUpdate).toHaveBeenCalledTimes(1);
    expect(mockedApi.presenceUpdate.mock.calls[0]![0]).toMatchObject({ approx: true, cell: ZONE });
    expect(getFixState()).toMatchObject({ cell: ZONE, approx: true });

    // дальше обычный heartbeat — продлевается уже квартал
    await act(async () => {
      jest.advanceTimersByTime(45_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedApi.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('фон + музыка: геолокацию отозвали — heartbeat останавливается, точка истечёт сама', async () => {
    setFixState({ cell: PRECISE, motion: 'still', approx: false });
    useSession.setState({ locationApprox: false });
    mockNp.track = { id: 'audius:1', title: 'Ночь', artist: 'Кино', artworkUrl: null, playback: 'full' };
    mockNp.playing = true;
    setAppState('background');
    mockState.gate = 'blocked';

    renderHook(() => usePresencePublisher());
    await confirmMode();
    await act(async () => {
      jest.advanceTimersByTime(3 * 45_000);
      await Promise.resolve();
    });
    expect(mockedApi.heartbeat).not.toHaveBeenCalled();
    expect(mockedApi.presenceUpdate).not.toHaveBeenCalled();
  });

  it('web: грубый fix публикуется как approx, даже если разрешение не сообщает coarse', async () => {
    const { Platform } = require('react-native') as typeof import('react-native');
    const restore = jest.replaceProperty(Platform, 'OS', 'web');
    mockState.gate = 'ok';
    useSession.setState({ locationApprox: false });
    renderHook(() => usePresencePublisher());
    await confirmMode();
    fix(2000);
    expect(sentUpdates().at(-1)).toMatchObject({ approx: true, cell: ZONE });
    restore.restore();
  });
});
