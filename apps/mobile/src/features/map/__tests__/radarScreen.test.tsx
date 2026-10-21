import type { AckResult, ClusterCell, ListenState, PresenceView, TrackRef, ViewportAck } from '@muzradar/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RadarScreen from '@/app/(app)/index';
import { useLocationGate, type LocationGateState } from '@/features/location/gate';
import { player } from '@/features/player';
import { makeTrack } from '@/features/player/__fixtures__/tracks';
import { IDLE_NOW_PLAYING, nowPlayingStore } from '@/features/player/state';
import { api } from '@/lib/api';
import { appConfig } from '@/lib/config';
import { useSession } from '@/state/session';
import type { CellCollection, ListenerCollection, ZoneCollection } from '../features';
import { useListenTogether } from '../listenTogether';

// Экран радара целиком: карта — мок MapLibre из jest.setup.ts, наружу (сокет, HTTP, геолокация, роутер) — только моки.
// Сокет подменён на уровне socket.io-client, поэтому emitAck из src/lib/realtime работает настоящий.

type Handler = (payload?: unknown) => void;
type Reply = (payload: unknown) => AckResult<unknown>;

/** «Сервер» в памяти: помнит подписки клиента, записывает emitWithAck и отвечает заданным ack. */
class FakeSocket {
  connected = true;
  active = true;
  recovered = false;
  readonly sent: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly replies = new Map<string, Reply>();

  on(event: string, handler: Handler) {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  timeout() {
    return {
      emitWithAck: async (event: string, payload: unknown) => {
        this.sent.push({ event, payload });
        const reply = this.replies.get(event);
        return reply ? reply(payload) : { ok: true, data: null };
      },
    };
  }

  emit() {
    return this;
  }

  connect() {
    return this;
  }

  disconnect() {
    return this;
  }

  reply(event: string, fn: Reply) {
    this.replies.set(event, fn);
  }

  /** Пакет от сервера всем подписчикам клиента. */
  push(event: string, payload: unknown) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }

  sentOf(event: string) {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload);
  }

  reset() {
    this.connected = true;
    this.sent.length = 0;
    this.replies.clear();
  }
}

const mockSocket = new FakeSocket();

jest.mock('socket.io-client', () => ({ io: jest.fn(() => mockSocket) }));
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => ({ ...require('react-native-reanimated/mock'), useReducedMotion: () => false }));
jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: jest.fn(async () => ({ coords: { longitude: 37.6176, latitude: 55.7558 } })),
  getCurrentPositionAsync: jest.fn(async () => ({ coords: { longitude: 37.6176, latitude: 55.7558 } })),
  Accuracy: { Balanced: 3 },
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), canDismiss: jest.fn(() => false), dismissAll: jest.fn() },
  useIsFocused: () => true,
}));
jest.mock('@/lib/config', () => ({
  appConfig: { apiUrl: 'http://test', locationGate: 'hard', liveLocation: false, appVariant: 'test', appVersion: '0.0.0' },
  absoluteUrl: (p: string | null) => p,
}));
jest.mock('@/lib/api', () => ({
  api: { nearby: jest.fn(), clusters: jest.fn() },
  authenticate: jest.fn(() => Promise.reject(new Error('сети в тестах нет'))),
}));
jest.mock('@/features/location/gate', () => ({ useLocationGate: jest.fn() }));
jest.mock('@/features/player', () => {
  const actual = jest.requireActual('@/features/player');
  return { ...actual, player: { ...actual.player, playTrackId: jest.fn(async () => undefined) } };
});

interface MapLibreMock {
  mockRefs: {
    map: { getBounds: jest.Mock; getZoom: jest.Mock } | null;
    camera: { easeTo: jest.Mock; jumpTo: jest.Mock; fitBounds: jest.Mock } | null;
    sources: Record<string, { getClusterExpansionZoom: jest.Mock } | undefined>;
  };
}
const { mockRefs } = jest.requireMock<MapLibreMock>('@maplibre/maplibre-react-native');

const mockedApi = api as jest.Mocked<typeof api>;
const mockedGate = useLocationGate as jest.MockedFunction<typeof useLocationGate>;
const playTrackId = player.playTrackId as jest.MockedFunction<typeof player.playTrackId>;
const config = appConfig as { locationGate: 'hard' | 'map-only' };

const SELF = 'u_selfselfselfselfself';
const ANYA = 'u_anyaanyaanyaanyaanya';
const BORIS = 'u_borisborisborisbori';
// Границы из мока карты (jest.setup.ts) — первый вьюпорт после загрузки стиля
const MOCK_BBOX = [37.6006, 55.7358, 37.6346, 55.7758];

function trackRef(n: number): TrackRef {
  const { id, title, artist, artworkUrl, playback } = makeTrack(n);
  return { id, title, artist, artworkUrl, playback };
}

function view(userId: string, over: Partial<PresenceView> = {}): PresenceView {
  return {
    userId,
    name: 'Аня',
    mapAvatarUrl: null,
    lng: 37.6205,
    lat: 55.7539,
    precision: 6,
    motion: 'walk',
    track: trackRef(7),
    playing: true,
    positionSec: 42,
    updatedAt: 1_000,
    ...over,
  };
}

function liveAck(users: PresenceView[]): Reply {
  return () => ({ ok: true, data: { mode: 'live', rooms: 2, users } satisfies ViewportAck });
}

function setGate(state: LocationGateState) {
  mockedGate.mockReturnValue({
    state,
    ok: state === 'ok' || state === 'ok_approx',
    approx: state === 'ok_approx',
    recheck: jest.fn(async () => undefined),
    resolve: jest.fn(async () => undefined),
  });
}

/** Экран с картой, которая «загрузила стиль» и отдала первый вьюпорт. */
async function renderRadar() {
  render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <RadarScreen />
    </SafeAreaProvider>,
  );
  const map = await screen.findByTestId('radar-map');
  await act(async () => {
    fireEvent(map, 'didFinishLoadingMap');
  });
  return map;
}

function listenersData(): ListenerCollection {
  return screen.getByTestId('maplibre-source-listeners').props.data as ListenerCollection;
}

const listenerIds = () => listenersData().features.map((f) => f.properties.userId);

function pressFeatures(testID: string, features: GeoJSON.Feature[]) {
  const stopPropagation = jest.fn();
  fireEvent.press(screen.getByTestId(testID), { nativeEvent: { features }, stopPropagation });
  return stopPropagation;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSocket.reset();
  config.locationGate = 'hard';
  setGate('ok');
  useSession.getState().reset();
  useSession.setState({ userId: SELF });
  nowPlayingStore.setState(IDLE_NOW_PLAYING);
  useListenTogether.setState({ userId: null, name: null, status: 'idle', error: null });
});

test('монтируется: заголовок, счётчик рядом и своя плашка без трека', async () => {
  mockSocket.reply('viewport:set', liveAck([view(ANYA), view(SELF, { name: 'Я' })]));
  render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <RadarScreen />
    </SafeAreaProvider>,
  );
  expect(screen.getByText('Радар')).toBeTruthy();
  expect(screen.getByText('Ищем…')).toBeTruthy();
  expect(screen.getByText('Включите музыку — вас увидят')).toBeTruthy();

  const map = await screen.findByTestId('radar-map');
  expect(screen.getByTestId('maplibre-native-user-location')).toBeTruthy();
  await act(async () => {
    fireEvent(map, 'didFinishLoadingMap');
  });

  // Первый вьюпорт — сразу после загрузки стиля, границы и зум берутся из ref карты
  expect(mockSocket.sentOf('viewport:set')).toEqual([{ bbox: MOCK_BBOX, zoom: 14 }]);
  // себя в счётчике нет
  expect(await screen.findByText('1 рядом')).toBeTruthy();
  expect(mockedApi.nearby).not.toHaveBeenCalled();

  fireEvent.press(screen.getByLabelText('Включите музыку — вас увидят'));
  expect(router.navigate).toHaveBeenCalledWith('/music');
});

test('своя плашка показывает, что играет, и ведёт в плеер', async () => {
  mockSocket.reply('viewport:set', liveAck([]));
  await renderRadar();
  act(() => {
    nowPlayingStore.setState({ track: makeTrack(3, { title: 'Группа крови', artist: 'Кино' }), playing: true });
  });
  expect(screen.getByText('В эфире · Группа крови — Кино')).toBeTruthy();

  act(() => {
    nowPlayingStore.setState({ playing: false });
  });
  expect(screen.getByText('На паузе · Группа крови — Кино')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('На паузе: Группа крови, Кино'));
  expect(router.push).toHaveBeenCalledWith('/player');
});

test('снимок и дельты: в источнике слушателей есть другой, но никогда нет себя', async () => {
  mockSocket.reply('viewport:set', liveAck([view(SELF, { name: 'Я' })]));
  await renderRadar();
  await screen.findByText('Рядом пока тихо');
  expect(listenerIds()).toEqual([]);

  act(() => {
    mockSocket.push('presence:delta', {
      upserts: [view(BORIS, { name: 'Борис', mapAvatarUrl: '/files/avatars/b.webp', updatedAt: 2_000 }), view(SELF, { updatedAt: 2_000 })],
      removes: [],
      at: 2_000,
    });
  });
  expect(listenerIds()).toEqual([BORIS]);
  expect(listenersData().features[0]!.geometry.coordinates).toEqual([37.6205, 55.7539]);
  expect(screen.getByTestId('maplibre-images').props.images).toEqual({ [`avatar:${BORIS}`]: '/files/avatars/b.webp' });
  expect(screen.getByText('1 рядом')).toBeTruthy();

  act(() => {
    mockSocket.push('presence:delta', { upserts: [], removes: [BORIS], at: 3_000 });
  });
  expect(listenerIds()).toEqual([]);
  expect(screen.getByText('0 рядом')).toBeTruthy();
});

test('тап по человеку открывает карточку, «Слушать вместе» включает его трек и следит за следующим', async () => {
  mockSocket.reply('viewport:set', liveAck([view(ANYA)]));
  mockSocket.reply('listen:join', () => ({
    ok: true,
    data: { userId: ANYA, track: trackRef(7), playing: true, positionSec: 50, at: 2_000 } satisfies ListenState,
  }));
  await renderRadar();
  await waitFor(() => expect(listenerIds()).toEqual([ANYA]));

  const feature = listenersData().features[0]!;
  const stop = pressFeatures('maplibre-source-listeners', [feature]);
  // иначе нажатие дойдёт до карты и тут же закроет карточку
  expect(stop).toHaveBeenCalled();
  const sheet = await screen.findByTestId('listener-sheet');
  expect(sheet).toBeTruthy();
  // блок трека скрыт от скринридера — он читает сводку целиком
  expect(screen.getByLabelText('Аня, идёт, слушает: Трек 7, Артист 7')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByTestId('listen-together'));
  });
  expect(mockSocket.sentOf('listen:join')).toEqual([{ userId: ANYA }]);
  expect(playTrackId).toHaveBeenCalledTimes(1);
  const [trackId, source, startAt] = playTrackId.mock.calls[0]!;
  expect(trackId).toBe('audius:t7');
  expect(source).toEqual({ kind: 'listen', userId: ANYA, name: 'Аня' });
  // с того же места, где сейчас слушатель (плюс поправка на загрузку)
  expect(startAt).toBeGreaterThanOrEqual(50);
  expect(await screen.findByText('Вы слушаете вместе')).toBeTruthy();

  act(() => {
    mockSocket.push('listen:state', { userId: ANYA, track: trackRef(8), playing: true, positionSec: 0, at: 3_000 } satisfies ListenState);
  });
  expect(playTrackId).toHaveBeenCalledTimes(2);
  expect(playTrackId.mock.calls[1]![0]).toBe('audius:t8');
});

test('тап по карте закрывает карточку', async () => {
  mockSocket.reply('viewport:set', liveAck([view(ANYA)]));
  const map = await renderRadar();
  await waitFor(() => expect(listenerIds()).toEqual([ANYA]));
  pressFeatures('maplibre-source-listeners', [listenersData().features[0]!]);
  await screen.findByTestId('listener-sheet');

  fireEvent.press(map);
  await waitFor(() => expect(screen.queryByTestId('listener-sheet')).toBeNull());
});

test('тап по кластеру приближает камеру до зума раскрытия', async () => {
  mockSocket.reply('viewport:set', liveAck([view(ANYA), view(BORIS)]));
  await renderRadar();
  await waitFor(() => expect(listenerIds()).toHaveLength(2));

  const cluster: GeoJSON.Feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [37.62, 55.75] },
    properties: { cluster: true, cluster_id: 7, point_count: 2 },
  };
  await act(async () => {
    pressFeatures('maplibre-source-listeners', [cluster]);
  });
  expect(mockRefs.sources.listeners!.getClusterExpansionZoom).toHaveBeenCalledWith(7);
  expect(mockRefs.camera!.easeTo).toHaveBeenCalledWith({ center: [37.62, 55.75], zoom: 16, duration: 450 });
  expect(screen.queryByTestId('listener-sheet')).toBeNull();
});

test('без сокета снимок берётся по HTTP', async () => {
  mockSocket.connected = false;
  mockedApi.nearby.mockResolvedValue({ users: [view(ANYA), view(SELF)] });
  await renderRadar();
  expect(await screen.findByText('1 рядом')).toBeTruthy();
  expect(mockedApi.nearby).toHaveBeenCalledWith(MOCK_BBOX, 14, expect.anything());
  expect(mockSocket.sentOf('viewport:set')).toEqual([]);
  expect(listenerIds()).toEqual([ANYA]);
});

test('отдалили карту — кластеры по HTTP вместо отдельных людей', async () => {
  mockSocket.reply('viewport:set', (payload) => {
    const { zoom } = payload as { zoom: number };
    return zoom >= 12 ? liveAck([view(ANYA)])(payload) : { ok: true, data: { mode: 'clusters', rooms: 0, users: [] } satisfies ViewportAck };
  });
  const cells: ClusterCell[] = [{ cell: 'ucfv0', count: 12, lng: 37.6, lat: 55.75 }];
  mockedApi.clusters.mockResolvedValue({ precision: 5, cells });
  const map = await renderRadar();
  await waitFor(() => expect(listenerIds()).toEqual([ANYA]));

  const bounds = [37.2, 55.5, 38.0, 56.0];
  act(() => {
    fireEvent(map, 'regionDidChange', {
      nativeEvent: { center: [37.6, 55.75], zoom: 10, bounds, bearing: 0, pitch: 0, animated: false, userInteraction: true },
    });
  });
  // вьюпорт уходит с задержкой, чтобы не слать его на каждый кадр жеста
  await waitFor(() => expect(mockSocket.sentOf('viewport:set')).toHaveLength(2));
  expect(mockSocket.sentOf('viewport:set')[1]).toEqual({ bbox: bounds, zoom: 10 });

  expect(await screen.findByText('12 рядом')).toBeTruthy();
  expect(mockedApi.clusters).toHaveBeenCalledWith(bounds, 10, expect.anything());
  expect(listenerIds()).toEqual([]);
  const cellData = screen.getByTestId('maplibre-source-listener-cells').props.data as CellCollection;
  expect(cellData.features.map((f) => f.properties)).toEqual([{ cell: 'ucfv0', count: 12, countLabel: '12' }]);
});

describe('гейт геолокации', () => {
  test('map-only без доступа — вместо карты панель с одной кнопкой', async () => {
    config.locationGate = 'map-only';
    setGate('denied_can_ask');
    render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <RadarScreen />
      </SafeAreaProvider>,
    );
    expect(screen.getByText('Радар')).toBeTruthy();
    expect(screen.getByText('Карта откроется с геолокацией')).toBeTruthy();
    expect(screen.queryByTestId('radar-map')).toBeNull();
    expect(screen.queryByTestId('maplibre-map')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByText('Разрешить'));
    });
    expect(mockedGate.mock.results[0]!.value.resolve).toHaveBeenCalledTimes(1);
    expect(mockSocket.sent).toEqual([]);
  });

  test('map-only, пока идёт проверка, — карта без своей точки', async () => {
    config.locationGate = 'map-only';
    setGate('checking');
    mockSocket.reply('viewport:set', liveAck([]));
    await renderRadar();
    expect(screen.queryByText('Карта откроется с геолокацией')).toBeNull();
    expect(screen.queryByTestId('maplibre-native-user-location')).toBeNull();
  });

  test('hard без доступа — блокирует корневой экран, радар свою точку не рисует', async () => {
    setGate('blocked');
    mockSocket.reply('viewport:set', liveAck([]));
    await renderRadar();
    expect(screen.queryByText('Карта откроется с геолокацией')).toBeNull();
    expect(screen.queryByTestId('maplibre-native-user-location')).toBeNull();
    expect(screen.getByTestId('radar-recenter').props.accessibilityState).toMatchObject({ disabled: true });
  });
});

function zonesData(): ZoneCollection {
  return screen.getByTestId('maplibre-source-listener-zones').props.data as ZoneCollection;
}

test('приблизительный слушатель: квартал вместо пина, тап по зоне — тот же трек; смена режима схлопывает и раскрывает зону', async () => {
  mockSocket.reply('viewport:set', liveAck([view(ANYA, { approx: true })]));
  mockSocket.reply('listen:join', () => ({
    ok: true,
    data: { userId: ANYA, track: trackRef(7), playing: true, positionSec: 50, at: 2_000 } satisfies ListenState,
  }));
  await renderRadar();
  await waitFor(() => expect(listenerIds()).toEqual([ANYA]));

  // квартал нарисован, маркер — в его центре, а не в публичной точке
  expect(zonesData().features.map((f) => f.properties.userId)).toEqual([ANYA]);
  const marker = listenersData().features[0]!;
  expect(marker.properties.approx).toBe(true);
  expect(marker.geometry.coordinates).not.toEqual([37.6205, 55.7539]);

  // тап по зоне открывает ту же карточку и «Слушать вместе»
  const stop = pressFeatures('maplibre-source-listener-zones', [zonesData().features[0]!]);
  expect(stop).toHaveBeenCalled();
  expect(await screen.findByText('идёт · где-то в этом районе')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByTestId('listen-together'));
  });
  expect(playTrackId.mock.calls[0]![0]).toBe('audius:t7');

  // точная геопозиция включена — зона схлопывается в обычный пин
  act(() => {
    mockSocket.push('presence:delta', { upserts: [view(ANYA, { approx: false, updatedAt: 2_000 })], removes: [], at: 2_000 });
  });
  expect(zonesData().features).toEqual([]);
  expect(listenersData().features[0]!.geometry.coordinates).toEqual([37.6205, 55.7539]);

  // снова выключена — квартал раскрывается обратно
  act(() => {
    mockSocket.push('presence:delta', { upserts: [view(ANYA, { approx: true, updatedAt: 3_000 })], removes: [], at: 3_000 });
  });
  expect(zonesData().features.map((f) => f.properties.userId)).toEqual([ANYA]);
});
