import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { Linking, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { appConfig } from '@/lib/config';
import { useSession } from '@/state/session';
import { LOCATION_REQUIRED_TEXT, LocationGate, locationGateCopy } from '../LocationGate';

jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  enableNetworkProviderAsync: jest.fn(),
  PermissionStatus: { GRANTED: 'granted', UNDETERMINED: 'undetermined', DENIED: 'denied' },
}));
jest.mock('expo-intent-launcher', () => ({
  startActivityAsync: jest.fn(),
  ActivityAction: { LOCATION_SOURCE_SETTINGS: 'android.settings.LOCATION_SOURCE_SETTINGS' },
}));
jest.mock('expo-router', () => ({ router: { canDismiss: jest.fn(() => true), dismissAll: jest.fn() } }));
// объект создаётся внутри фабрики: jest.mock поднимается выше объявлений модуля
jest.mock('@/lib/config', () => ({
  appConfig: { apiUrl: 'http://test', locationGate: 'hard', liveLocation: false, appVariant: 'test', appVersion: '0.0.0' },
  absoluteUrl: (p: string | null) => p,
}));

const loc = Location as jest.Mocked<typeof Location>;
const config = appConfig as { locationGate: 'hard' | 'map-only' };

type Perm = Awaited<ReturnType<typeof Location.getForegroundPermissionsAsync>>;

function setDevice(servicesOn: boolean, p: { status: 'granted' | 'undetermined' | 'denied'; canAskAgain?: boolean; android?: { accuracy: 'fine' | 'coarse' } }) {
  loc.hasServicesEnabledAsync.mockResolvedValue(servicesOn);
  loc.getForegroundPermissionsAsync.mockResolvedValue({
    granted: p.status === 'granted',
    canAskAgain: true,
    expires: 'never',
    ...p,
  } as unknown as Perm);
}

function renderGate() {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <LocationGate />
    </SafeAreaProvider>,
  );
}

let openSettings: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  config.locationGate = 'hard';
  useSession.getState().reset();
  openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Состояние гейта общее на модуль, поэтому «идёт проверка» видно только в первом тесте файла
test('пока идёт проверка — ничего; доступ запрещён — непрозрачная блокировка с одной кнопкой', async () => {
  setDevice(true, { status: 'denied', canAskAgain: false });
  renderGate();
  expect(screen.queryByTestId('location-gate')).toBeNull();

  await screen.findByTestId('location-gate');
  expect(screen.getByText(LOCATION_REQUIRED_TEXT)).toBeTruthy();
  expect(screen.getByText('Доступ к геолокации запрещён')).toBeTruthy();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  // iOS: нативный модальный плеер выше покрытия — его сворачиваем
  expect(router.dismissAll).toHaveBeenCalledTimes(1);

  await act(async () => {
    fireEvent.press(screen.getByTestId('location-gate-action'));
  });
  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(useSession.getState().locationGranted).toBe(false);
});

test('приблизительная геолокация пропускает', async () => {
  setDevice(true, { status: 'granted', android: { accuracy: 'coarse' } });
  renderGate();
  await waitFor(() => expect(useSession.getState()).toMatchObject({ locationGranted: true, locationApprox: true }));
  expect(screen.queryByTestId('location-gate')).toBeNull();
});

test('разрешение выдали прямо с экрана блокировки — экран исчезает', async () => {
  setDevice(true, { status: 'denied', canAskAgain: true });
  renderGate();
  await screen.findByText('Разрешить');
  loc.requestForegroundPermissionsAsync.mockImplementation(async () => {
    setDevice(true, { status: 'granted' });
    return {} as never;
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('location-gate-action'));
  });
  expect(loc.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByTestId('location-gate')).toBeNull());
  expect(useSession.getState().locationGranted).toBe(true);
});

test('режим map-only не блокирует, но сессия знает правду', async () => {
  config.locationGate = 'map-only';
  setDevice(false, { status: 'granted' });
  useSession.setState({ locationGranted: true });
  renderGate();
  await waitFor(() => expect(useSession.getState().locationGranted).toBe(false));
  expect(screen.queryByTestId('location-gate')).toBeNull();
});

test('на Android модальные экраны не сворачиваются: покрытие и так сверху', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  setDevice(false, { status: 'granted' });
  renderGate();
  await screen.findByText('Включить геолокацию');
  expect(router.dismissAll).not.toHaveBeenCalled();
});

describe('тексты гейта', () => {
  test.each<[Parameters<typeof locationGateCopy>[0], string, string]>([
    ['services_off', 'android', 'Включить геолокацию'],
    ['services_off', 'ios', 'Открыть настройки'],
    ['undetermined', 'ios', 'Разрешить'],
    ['denied_can_ask', 'android', 'Разрешить'],
    ['blocked', 'ios', 'Открыть настройки'],
    ['blocked', 'android', 'Открыть настройки'],
  ])('%s (%s) → «%s» и причина', (state, os, action) => {
    const copy = locationGateCopy(state, os);
    expect(copy.action).toBe(action);
    expect(copy.reason.length).toBeGreaterThan(20);
  });

  test.each(['ok', 'ok_approx', 'checking'] as const)('%s — действовать не нужно', (state) => {
    expect(locationGateCopy(state).action).toBeNull();
  });
});
