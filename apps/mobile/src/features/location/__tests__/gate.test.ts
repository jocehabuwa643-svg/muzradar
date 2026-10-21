import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import { Linking, Platform } from 'react-native';
import { useSession } from '@/state/session';
import { readLocationGate, resolveLocationGate, useLocationGate } from '../gate';

jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  enableNetworkProviderAsync: jest.fn(),
  // координаты гейту не нужны: если код их попросит, тест упадёт
  getCurrentPositionAsync: jest.fn(() => {
    throw new Error('гейт не должен читать координаты');
  }),
  getLastKnownPositionAsync: jest.fn(() => {
    throw new Error('гейт не должен читать координаты');
  }),
  watchPositionAsync: jest.fn(() => {
    throw new Error('гейт не должен читать координаты');
  }),
  PermissionStatus: { GRANTED: 'granted', UNDETERMINED: 'undetermined', DENIED: 'denied' },
}));

jest.mock('expo-intent-launcher', () => ({
  startActivityAsync: jest.fn(),
  ActivityAction: { LOCATION_SOURCE_SETTINGS: 'android.settings.LOCATION_SOURCE_SETTINGS' },
}));

const loc = Location as jest.Mocked<typeof Location>;
const intents = IntentLauncher as jest.Mocked<typeof IntentLauncher>;

type Perm = Awaited<ReturnType<typeof Location.getForegroundPermissionsAsync>>;

// В типах статус — enum PermissionStatus; в рантайме это те же строки
type Status = 'granted' | 'undetermined' | 'denied';

function perm(p: Omit<Partial<Perm>, 'status'> & { status: Status }): Perm {
  return { granted: p.status === 'granted', canAskAgain: true, expires: 'never', ...p } as unknown as Perm;
}

function setDevice(servicesOn: boolean, p: Perm) {
  loc.hasServicesEnabledAsync.mockResolvedValue(servicesOn);
  loc.getForegroundPermissionsAsync.mockResolvedValue(p);
}

let openSettings: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  loc.requestForegroundPermissionsAsync.mockResolvedValue(perm({ status: 'granted' }) as never);
  intents.startActivityAsync.mockResolvedValue({ resultCode: 0 } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('readLocationGate: все шесть состояний', () => {
  test.each<[string, boolean, Perm, string]>([
    ['службы геолокации выключены', false, perm({ status: 'granted' }), 'services_off'],
    ['ещё не спрашивали', true, perm({ status: 'undetermined' }), 'undetermined'],
    ['отказ, можно спросить снова', true, perm({ status: 'denied', canAskAgain: true }), 'denied_can_ask'],
    ['отказ навсегда', true, perm({ status: 'denied', canAskAgain: false }), 'blocked'],
    ['разрешено точно (Android fine)', true, perm({ status: 'granted', android: { accuracy: 'fine' } }), 'ok'],
    ['разрешено точно (iOS full)', true, perm({ status: 'granted', ios: { scope: 'whenInUse', accuracy: 'full' } }), 'ok'],
    ['приблизительно (Android coarse)', true, perm({ status: 'granted', android: { accuracy: 'coarse' } }), 'ok_approx'],
    ['приблизительно (iOS reduced)', true, perm({ status: 'granted', ios: { scope: 'whenInUse', accuracy: 'reduced' } }), 'ok_approx'],
  ])('%s → %s', async (_name, servicesOn, p, expected) => {
    setDevice(servicesOn, p);
    await expect(readLocationGate()).resolves.toBe(expected);
  });

  test('при выключенных службах разрешение даже не читается', async () => {
    setDevice(false, perm({ status: 'granted' }));
    await readLocationGate();
    expect(loc.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('resolveLocationGate: действие для каждого состояния', () => {
  test.each(['undetermined', 'denied_can_ask'] as const)('%s → системный запрос «При использовании»', async (state) => {
    await resolveLocationGate(state);
    expect(loc.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });

  test.each(['ios', 'android'] as const)('blocked → настройки приложения (%s)', async (os) => {
    jest.replaceProperty(Platform, 'OS', os);
    await resolveLocationGate('blocked');
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(loc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  test('services_off на Android → системный диалог Google Play', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    loc.enableNetworkProviderAsync.mockResolvedValue(undefined);
    await resolveLocationGate('services_off');
    expect(loc.enableNetworkProviderAsync).toHaveBeenCalledTimes(1);
    expect(intents.startActivityAsync).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  test('services_off на Android без диалога (отказ или нет GMS) → экран настроек геолокации', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    loc.enableNetworkProviderAsync.mockRejectedValue(new Error('LocationSettingsUnsatisfiedException'));
    await resolveLocationGate('services_off');
    expect(intents.startActivityAsync).toHaveBeenCalledWith('android.settings.LOCATION_SOURCE_SETTINGS');
    expect(openSettings).not.toHaveBeenCalled();
  });

  test('services_off на Android, и интент не открылся → хотя бы настройки приложения', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    loc.enableNetworkProviderAsync.mockRejectedValue(new Error('declined'));
    intents.startActivityAsync.mockRejectedValue(new Error('no activity'));
    await resolveLocationGate('services_off');
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test('services_off на iOS → Настройки (публичной ссылки на службы геолокации нет)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await resolveLocationGate('services_off');
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(loc.enableNetworkProviderAsync).not.toHaveBeenCalled();
    expect(intents.startActivityAsync).not.toHaveBeenCalled();
  });

  test.each(['ok', 'ok_approx', 'checking'] as const)('%s → ничего не делает', async (state) => {
    await resolveLocationGate(state);
    expect(loc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(loc.enableNetworkProviderAsync).not.toHaveBeenCalled();
  });
});

// Хук держит общее состояние на уровне модуля, поэтому в файле он проверяется одним сценарием
describe('useLocationGate', () => {
  test('проверяет при монтировании, пишет результат в сессию и перепроверяет после resolve', async () => {
    useSession.getState().reset();

    setDevice(true, perm({ status: 'undetermined' }));
    const { result, unmount } = renderHook(() => useLocationGate());
    expect(result.current.state).toBe('checking');
    await waitFor(() => expect(result.current.state).toBe('undetermined'));
    expect(result.current.ok).toBe(false);
    expect(useSession.getState().locationGranted).toBe(false);

    // пользователь разрешил приблизительную геолокацию
    loc.requestForegroundPermissionsAsync.mockImplementation(async () => {
      setDevice(true, perm({ status: 'granted', android: { accuracy: 'coarse' } }));
      return perm({ status: 'granted', android: { accuracy: 'coarse' } }) as never;
    });
    await act(async () => {
      await result.current.resolve();
    });
    expect(result.current.state).toBe('ok_approx');
    expect(result.current.approx).toBe(true);
    expect(useSession.getState()).toMatchObject({ locationGranted: true, locationApprox: true });
    unmount();
  });
});
