import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ConsentStep from '@/app/onboarding/consent';
import LocationStep from '@/app/onboarding/index';
import NameStep from '@/app/onboarding/name';
import TasteStep from '@/app/onboarding/taste';
import { CONSENTS_OUTDATED_MESSAGE } from '@/features/onboarding/completion';
import { api, ApiError, NetworkError } from '@/lib/api';
import { useSession } from '@/state/session';

// Экраны рендерятся целиком; наружу (сеть, геолокация) — только моки.
// Reanimated 4 без нативного рантайма worklets в Jest не грузится — берём официальные моки пакетов.
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => ({ ...require('react-native-reanimated/mock'), useReducedMotion: () => false }));
jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: jest.fn(async () => true),
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true, expires: 'never' })),
  requestForegroundPermissionsAsync: jest.fn(),
  enableNetworkProviderAsync: jest.fn(),
  PermissionStatus: { GRANTED: 'granted', UNDETERMINED: 'undetermined', DENIED: 'denied' },
}));

jest.mock('@/lib/api', () => {
  const actual = jest.requireActual('@/lib/api');
  return {
    ...actual,
    api: { putConsents: jest.fn(), putProfile: jest.fn(), artists: jest.fn(async () => ({ artists: [] })) },
  };
});

const mockedApi = api as jest.Mocked<typeof api>;

function wrap(ui: ReactElement) {
  // gcTime: Infinity — без таймеров сборки кэша, которые держат Jest после тестов
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  useSession.getState().reset();
  useSession.setState({ locationGranted: true });
});

test('шаг 1: слоган и главная кнопка на месте', async () => {
  useSession.setState({ locationGranted: false });
  wrap(<LocationStep />);
  expect(screen.getByText('МУЗРАДАР')).toBeTruthy();
  expect(screen.getByText('Слушай тех, кто рядом')).toBeTruthy();
  // разрешение уже выдано — гейт пишет его в сессию, и guard уведёт дальше
  await waitFor(() => expect(useSession.getState().locationGranted).toBe(true));
});

describe('шаг 2: согласия', () => {
  test('до «Продолжить» ничего не отправляется; все галочки по отдельности', async () => {
    wrap(<ConsentStep />);
    const next = screen.getByTestId('consent-continue');
    fireEvent.changeText(screen.getByTestId('birth-year'), '1999');
    fireEvent.press(screen.getByTestId('consent-processing'));
    fireEvent.press(screen.getByTestId('consent-dissemination'));
    expect(next.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId('consent-rules'));
    expect(mockedApi.putConsents).not.toHaveBeenCalled();
    expect(next.props.accessibilityState.disabled).toBe(false);

    mockedApi.putConsents.mockResolvedValue({} as never);
    await act(async () => {
      fireEvent.press(next);
    });
    const body = mockedApi.putConsents.mock.calls[0]![0];
    expect(body.birthYear).toBe(1999);
    expect(body.consents.dissemination.scope).toEqual(['name', 'avatar', 'track', 'location']);
    expect(useSession.getState()).toMatchObject({ consentsSaved: true, draft: { birthYear: 1999 } });
  });

  test('младше 16 — блокирующее сообщение', () => {
    wrap(<ConsentStep />);
    fireEvent.changeText(screen.getByTestId('birth-year'), String(new Date().getUTCFullYear() - 12));
    expect(screen.getByTestId('age-blocked')).toBeTruthy();
    expect(screen.queryByTestId('consent-processing')).toBeNull();
  });

  test('сервер ответил age_restricted — блокирующее сообщение', async () => {
    mockedApi.putConsents.mockRejectedValue(new ApiError(403, 'age_restricted', 'Регистрация с 16 лет'));
    wrap(<ConsentStep />);
    fireEvent.changeText(screen.getByTestId('birth-year'), '1999');
    for (const k of ['processing', 'dissemination', 'rules']) fireEvent.press(screen.getByTestId(`consent-${k}`));
    await act(async () => {
      fireEvent.press(screen.getByTestId('consent-continue'));
    });
    expect(screen.getByTestId('age-blocked')).toBeTruthy();
    expect(useSession.getState().consentsSaved).toBe(false);
  });

  test('нет сети — сообщение и «Повторить»', async () => {
    mockedApi.putConsents.mockRejectedValue(new NetworkError('Нет соединения с сервером'));
    wrap(<ConsentStep />);
    fireEvent.changeText(screen.getByTestId('birth-year'), '1999');
    for (const k of ['processing', 'dissemination', 'rules']) fireEvent.press(screen.getByTestId(`consent-${k}`));
    await act(async () => {
      fireEvent.press(screen.getByTestId('consent-continue'));
    });
    expect(screen.getByText('Повторить')).toBeTruthy();
  });

  test('устаревшие версии документов — просим обновить приложение', async () => {
    mockedApi.putConsents.mockRejectedValue(new ApiError(409, 'consents_outdated', 'Consents outdated'));
    wrap(<ConsentStep />);
    fireEvent.changeText(screen.getByTestId('birth-year'), '1999');
    for (const k of ['processing', 'dissemination', 'rules']) fireEvent.press(screen.getByTestId(`consent-${k}`));
    await act(async () => {
      fireEvent.press(screen.getByTestId('consent-continue'));
    });
    expect(screen.getByText(CONSENTS_OUTDATED_MESSAGE)).toBeTruthy();
    expect(useSession.getState().consentsSaved).toBe(false);
  });
});

test('шаг 3: имя сохраняется в черновик', () => {
  useSession.setState({ consentsSaved: true });
  wrap(<NameStep />);
  fireEvent.changeText(screen.getByTestId('name-input'), '  Лиза ');
  fireEvent.press(screen.getByTestId('name-continue'));
  expect(useSession.getState().draft.name).toBe('Лиза');
});

describe('шаг 5: вкус', () => {
  beforeEach(() => {
    useSession.setState((s) => ({ consentsSaved: true, avatarSaved: true, draft: { ...s.draft, name: 'Лиза' } }));
  });

  test('частичный выбор сохраняется в черновике, завершение шлёт имя и вкус', async () => {
    wrap(<TasteStep />);
    for (const g of ['rock', 'jazz', 'indie']) fireEvent.press(screen.getByTestId(`genre-${g}`));
    fireEvent.press(screen.getByTestId('mood-night'));
    expect(useSession.getState().draft.taste).toMatchObject({ genres: ['rock', 'jazz', 'indie'], moods: ['night'] });
    fireEvent.changeText(screen.getByTestId('artist-input'), 'Кино');
    fireEvent(screen.getByTestId('artist-input'), 'submitEditing');
    expect(useSession.getState().draft.taste.artists).toEqual(['Кино']);

    mockedApi.putProfile.mockResolvedValue({} as never);
    await act(async () => {
      fireEvent.press(screen.getByTestId('taste-finish'));
    });
    expect(mockedApi.putProfile).toHaveBeenCalledWith({
      name: 'Лиза',
      taste: { genres: ['rock', 'jazz', 'indie'], moods: ['night'], artists: ['Кино'] },
    });
  });

  test('409 без аватара возвращает на шаг аватара', async () => {
    useSession.getState().updateDraft({ taste: { genres: ['rock', 'jazz', 'indie'], moods: ['night'], artists: ['Кино'] } });
    mockedApi.putProfile.mockRejectedValue(new ApiError(409, 'onboarding_incomplete', 'Сначала пройдите шаги', { missing: ['avatar'] }));
    wrap(<TasteStep />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('taste-finish'));
    });
    expect(useSession.getState().avatarSaved).toBe(false);
  });

  test('422 name_rejected стирает имя', async () => {
    useSession.getState().updateDraft({ taste: { genres: ['rock', 'jazz', 'indie'], moods: ['night'], artists: ['Кино'] } });
    mockedApi.putProfile.mockRejectedValue(new ApiError(422, 'name_rejected', 'Имя не подходит'));
    wrap(<TasteStep />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('taste-finish'));
    });
    expect(useSession.getState().draft.name).toBeNull();
  });
});
