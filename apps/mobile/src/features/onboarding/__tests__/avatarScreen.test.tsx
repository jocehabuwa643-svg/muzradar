import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useCameraPermissions } from 'expo-camera';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AvatarStep from '@/app/onboarding/avatar';
import { buildAvatar } from '@/features/onboarding/avatarPipeline';
import { api, ApiError } from '@/lib/api';
import { selectOnboardingStep, useSession } from '@/state/session';

jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: jest.fn(async () => true),
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true, expires: 'never' })),
  requestForegroundPermissionsAsync: jest.fn(),
  enableNetworkProviderAsync: jest.fn(),
  PermissionStatus: { GRANTED: 'granted', UNDETERMINED: 'undetermined', DENIED: 'denied' },
}));
// Камера — заглушка с тем же контрактом: ref.takePictureAsync и событие готовности
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  const takePictureAsync = jest.fn();
  const CameraView = React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    React.useImperativeHandle(ref, () => ({ takePictureAsync }));
    return React.createElement(View, { testID: 'camera', onCameraReady: props.onCameraReady, cameraProps: props });
  });
  return { CameraView, useCameraPermissions: jest.fn(), mockTakePictureAsync: takePictureAsync };
});
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: { JPEG: 'jpeg', WEBP: 'webp' } }));
jest.mock('@/features/onboarding/faceDetector', () => ({ warmUpFaceDetector: jest.fn(), mlkitFaceDetector: {} }));
jest.mock('@/features/onboarding/avatarPipeline', () => ({
  ...jest.requireActual('@/features/onboarding/avatarPipeline'),
  buildAvatar: jest.fn(),
}));
jest.mock('@/lib/api', () => ({ ...jest.requireActual('@/lib/api'), api: { putAvatar: jest.fn() } }));

const takePictureAsync = (jest.requireMock('expo-camera') as { mockTakePictureAsync: jest.Mock }).mockTakePictureAsync;
const mockedPermissions = useCameraPermissions as jest.Mock;
const mockedBuild = buildAvatar as jest.Mock;
const mockedApi = api as jest.Mocked<typeof api>;

const AVATAR = { uri: 'file:///cache/avatar.webp', base64: 'UklGRiQAAABXRUJQ', bytes: 12 };

function permission(p: { granted: boolean; canAskAgain: boolean }) {
  return { ...p, status: p.granted ? 'granted' : 'denied', expires: 'never' };
}

function renderStep() {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <AvatarStep />
    </SafeAreaProvider>,
  );
}

async function shoot() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('avatar-shutter'));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useSession.getState().reset();
  useSession.setState((s) => ({ locationGranted: true, consentsSaved: true, draft: { ...s.draft, name: 'Лиза' } }));
  takePictureAsync.mockResolvedValue({ uri: 'file:///cache/shot.jpg', width: 3024, height: 4032, format: 'jpg' });
});

test('доступ к камере запрещён навсегда — ведём в настройки, галереи нет', async () => {
  const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  mockedPermissions.mockReturnValue([permission({ granted: false, canAskAgain: false }), jest.fn(), jest.fn(async () => undefined)]);
  renderStep();
  expect(screen.getByText('Доступ к камере запрещён')).toBeTruthy();
  expect(screen.getByText('Открыть настройки')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByTestId('camera-permission-action'));
  });
  expect(openSettings).toHaveBeenCalledTimes(1);
  openSettings.mockRestore();
});

test('разрешение можно запросить — системный запрос', async () => {
  const request = jest.fn(async () => permission({ granted: true, canAskAgain: true }));
  mockedPermissions.mockReturnValue([permission({ granted: false, canAskAgain: true }), request, jest.fn(async () => undefined)]);
  renderStep();
  await act(async () => {
    fireEvent.press(screen.getByTestId('camera-permission-action'));
  });
  expect(request).toHaveBeenCalledTimes(1);
});

describe('съёмка', () => {
  beforeEach(() => {
    mockedPermissions.mockReturnValue([permission({ granted: true, canAskAgain: true }), jest.fn(), jest.fn(async () => undefined)]);
  });

  test('фронтальная камера с зеркалом; затвор — только после готовности; параметры снимка', async () => {
    renderStep();
    const props = screen.getByTestId('camera').props.cameraProps;
    expect(props).toMatchObject({ facing: 'front', mirror: true, mode: 'picture', animateShutter: false });
    expect(screen.getByText('Лицо в круг, смотрите прямо')).toBeTruthy();
    expect(screen.getByTestId('avatar-shutter').props.accessibilityState.disabled).toBe(true);

    fireEvent(screen.getByTestId('camera'), 'cameraReady');
    expect(screen.getByTestId('avatar-shutter').props.accessibilityState.disabled).toBe(false);

    mockedBuild.mockResolvedValue({ ok: false, reason: 'many' });
    await shoot();
    expect(takePictureAsync).toHaveBeenCalledWith({ quality: 0.8, exif: false, skipProcessing: false, shutterSound: false });
    expect(mockedBuild).toHaveBeenCalledWith('file:///cache/shot.jpg');
    // вердикт — на экране камеры, можно сразу переснять
    expect(screen.getByText('В кадре несколько лиц')).toBeTruthy();
    expect(screen.getByTestId('avatar-shutter')).toBeTruthy();
  });

  test('удачный кадр → предпросмотр → «Готово» загружает и завершает шаг', async () => {
    renderStep();
    fireEvent(screen.getByTestId('camera'), 'cameraReady');
    mockedBuild.mockResolvedValue({ ok: true, avatar: AVATAR });
    await shoot();
    expect(screen.getByText('Переснять')).toBeTruthy();
    expect(screen.queryByTestId('camera')).toBeNull();

    mockedApi.putAvatar.mockResolvedValue({ avatarUrl: '/a.webp', mapAvatarUrl: '/m.webp', bytes: 12 });
    await act(async () => {
      fireEvent.press(screen.getByTestId('avatar-done'));
    });
    expect(mockedApi.putAvatar).toHaveBeenCalledWith(AVATAR.base64);
    expect(useSession.getState()).toMatchObject({ avatarSaved: true, draft: { avatarUri: AVATAR.uri } });
    expect(selectOnboardingStep(useSession.getState())).toBe('taste');
  });

  test('«Переснять» возвращает камеру', async () => {
    renderStep();
    fireEvent(screen.getByTestId('camera'), 'cameraReady');
    mockedBuild.mockResolvedValue({ ok: true, avatar: AVATAR });
    await shoot();
    fireEvent.press(screen.getByTestId('avatar-retake'));
    expect(screen.getByTestId('camera')).toBeTruthy();
    // новая камера — снова ждём готовности
    expect(screen.getByTestId('avatar-shutter').props.accessibilityState.disabled).toBe(true);
    expect(mockedApi.putAvatar).not.toHaveBeenCalled();
  });

  test('сервер требует сначала согласия — возврат на шаг согласий', async () => {
    renderStep();
    fireEvent(screen.getByTestId('camera'), 'cameraReady');
    mockedBuild.mockResolvedValue({ ok: true, avatar: AVATAR });
    await shoot();
    mockedApi.putAvatar.mockRejectedValue(new ApiError(409, 'onboarding_incomplete', 'Сначала согласия', { missing: ['consents'] }));
    await act(async () => {
      fireEvent.press(screen.getByTestId('avatar-done'));
    });
    const s = useSession.getState();
    expect(s.avatarSaved).toBe(false);
    expect(selectOnboardingStep(s)).toBe('consent');
  });
});
