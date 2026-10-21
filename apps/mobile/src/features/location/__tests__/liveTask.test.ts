import { encodeGeohash, GEO_PRECISION } from '@muzradar/shared';
import type { NowPlaying } from '@/features/player';

// Флаг Live-режима читается в глобальной области liveTask.ts, поэтому модуль грузится заново под каждый случай.
// import() в этом рантайме Jest недоступен — только синхронный require из свежего реестра модулей.
declare function require<T = unknown>(id: string): T;

const mockFlags = { liveLocation: false };
const mockSession = { onboardedAt: '2026-01-01T00:00:00.000Z' as string | null, locationApprox: false };
const mockNowPlaying: NowPlaying = {
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

jest.mock('@/lib/config', () => ({
  get appConfig() {
    return { apiUrl: 'http://api.test', locationGate: 'hard', liveLocation: mockFlags.liveLocation, appVariant: 'test', appVersion: '0.0.0' };
  },
  absoluteUrl: (p: string | null) => p,
}));

jest.mock('@/lib/api', () => ({ api: { presenceUpdate: jest.fn(async () => undefined), heartbeat: jest.fn(async () => undefined) } }));
jest.mock('@/state/session', () => ({ useSession: { getState: () => mockSession } }));
jest.mock('@/features/player', () => ({ getNowPlaying: () => mockNowPlaying }));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => false),
}));

jest.mock('expo-location', () => ({
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  startLocationUpdatesAsync: jest.fn(async () => undefined),
  stopLocationUpdatesAsync: jest.fn(async () => undefined),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
}));

type LiveTask = typeof import('../liveTask');
type LiveData = Parameters<LiveTask['handleLiveLocations']>[0];

function load(liveLocation: boolean, appState: 'active' | 'background' = 'active') {
  mockFlags.liveLocation = liveLocation;
  jest.resetModules();
  const RN = require<typeof import('react-native')>('react-native');
  Object.defineProperty(RN.AppState, 'currentState', { value: appState, configurable: true, writable: true });
  const TaskManager = require<jest.Mocked<typeof import('expo-task-manager')>>('expo-task-manager');
  const Location = require<jest.Mocked<typeof import('expo-location')>>('expo-location');
  const api = require<{ api: jest.Mocked<(typeof import('@/lib/api'))['api']> }>('@/lib/api').api;
  const liveTask = require<LiveTask>('../liveTask');
  return { TaskManager, Location, api, liveTask };
}

const PLAYING_TRACK = { id: 'audius:1', title: 'Ночь', artist: 'Кино-клуб', artworkUrl: null, playback: 'full' };

const fix = (latitude: number, longitude: number, speed = 0) =>
  ({
    locations: [
      {
        coords: { latitude, longitude, accuracy: 20, speed, altitude: null, heading: null, altitudeAccuracy: null },
        timestamp: 1_700_000_000_000,
      },
    ],
  }) as unknown as LiveData;

beforeEach(() => {
  mockSession.onboardedAt = '2026-01-01T00:00:00.000Z';
  mockSession.locationApprox = false;
  Object.assign(mockNowPlaying, { track: null, playing: false, positionSec: 0 });
});

describe('флаг выключен', () => {
  it('не регистрирует фоновую задачу', () => {
    const { TaskManager } = load(false);
    expect(TaskManager.defineTask).not.toHaveBeenCalled();
  });

  it('startLiveLocation ничего не запускает', async () => {
    const { Location, liveTask } = load(false);
    await expect(liveTask.startLiveLocation()).resolves.toBeUndefined();
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
    // спрашивать нативный модуль тоже не о чем
    expect(Location.hasStartedLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('stopLiveLocation и isLiveLocationRunning безопасны', async () => {
    const { Location, liveTask } = load(false);
    await expect(liveTask.stopLiveLocation()).resolves.toBeUndefined();
    await expect(liveTask.isLiveLocationRunning()).resolves.toBe(false);
    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(Location.hasStartedLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('имя задачи остаётся частью контракта', () => {
    const { liveTask } = load(false);
    expect(liveTask.LIVE_LOCATION_TASK).toBe('muzradar.live-location');
  });
});

describe('флаг включён', () => {
  it('регистрирует задачу под тем же именем', () => {
    const { TaskManager, liveTask } = load(true);
    expect(TaskManager.defineTask).toHaveBeenCalledTimes(1);
    expect(TaskManager.defineTask.mock.calls[0]![0]).toBe(liveTask.LIVE_LOCATION_TASK);
  });

  it('запускает обновления щадяще и с постоянным уведомлением', async () => {
    const { Location, liveTask } = load(true);
    await liveTask.startLiveLocation();
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith('muzradar.live-location', {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 50,
      timeInterval: 30_000,
      deferredUpdatesInterval: 30_000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'МУЗРАДАР',
        notificationBody: 'Вы видны на карте, пока играет музыка',
        notificationColor: '#C8FF3D',
        killServiceOnDestroy: true,
      },
    });
  });

  it('из фона не запускается: Android запретил бы foreground service', async () => {
    const { Location, liveTask } = load(true, 'background');
    await liveTask.startLiveLocation();
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('не запускает второй раз, если задача уже работает', async () => {
    const { Location, liveTask } = load(true);
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    await liveTask.startLiveLocation();
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
    await liveTask.stopLiveLocation();
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith('muzradar.live-location');
  });
});

describe('обработка фоновых фиксов', () => {
  it('на сервер уходит ячейка, а не координаты', async () => {
    const { api, liveTask } = load(true);
    Object.assign(mockNowPlaying, { track: PLAYING_TRACK, playing: true });

    await liveTask.handleLiveLocations(fix(55.7558, 37.6176));

    expect(api.presenceUpdate).toHaveBeenCalledTimes(1);
    const sent = api.presenceUpdate.mock.calls[0]![0];
    expect(sent.cell).toBe(encodeGeohash(55.7558, 37.6176, GEO_PRECISION.client));
    expect(Object.keys(sent).sort()).toEqual(['approx', 'cell', 'motion', 'playing', 'positionSec', 'track']);
    expect(JSON.stringify(sent)).not.toContain('55.75');
    expect(JSON.stringify(sent)).not.toContain('37.61');
  });

  it('молчит, пока музыка не играет — так обещает уведомление', async () => {
    const { api, liveTask } = load(true);
    await liveTask.handleLiveLocations(fix(55.7558, 37.6176));
    expect(api.presenceUpdate).not.toHaveBeenCalled();
  });

  it('молчит до конца онбординга и на пустой доставке', async () => {
    const { api, liveTask } = load(true);
    Object.assign(mockNowPlaying, { track: PLAYING_TRACK, playing: true });
    mockSession.onboardedAt = null;
    await liveTask.handleLiveLocations(fix(55.7558, 37.6176));
    await liveTask.handleLiveLocations(null);
    await liveTask.handleLiveLocations({});
    expect(api.presenceUpdate).not.toHaveBeenCalled();
  });

  it('повторный фикс в той же ячейке сервер не беспокоит', async () => {
    const { api, liveTask } = load(true);
    Object.assign(mockNowPlaying, { track: PLAYING_TRACK, playing: true });
    await liveTask.handleLiveLocations(fix(55.7558, 37.6176));
    await liveTask.handleLiveLocations(fix(55.75581, 37.61761));
    expect(api.presenceUpdate).toHaveBeenCalledTimes(1);
  });

  it('сетевая ошибка в фоне не роняет задачу', async () => {
    const { api, liveTask } = load(true);
    Object.assign(mockNowPlaying, { track: PLAYING_TRACK, playing: true });
    api.presenceUpdate.mockRejectedValueOnce(new Error('offline'));
    await expect(liveTask.handleLiveLocations(fix(55.7558, 37.6176))).resolves.toBeUndefined();
  });
});
