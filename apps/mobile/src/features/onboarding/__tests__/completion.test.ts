import { selectOnboardingStep, useSession } from '@/state/session';
import { ApiError, NetworkError } from '@/lib/api';
import {
  AVATAR_REJECTED_MESSAGE,
  avatarUploadError,
  CONSENTS_OUTDATED_MESSAGE,
  consentsSubmitError,
  readMissingSteps,
  rejectName,
  rewindToMissingSteps,
  useOnboardingNotice,
} from '../completion';

function finishedAllButTaste() {
  useSession.getState().reset();
  useSession.setState((s) => ({
    locationGranted: true,
    consentsSaved: true,
    avatarSaved: true,
    draft: { ...s.draft, birthYear: 1999, name: 'Лиза', avatarUri: 'file:///avatar.webp', taste: { genres: ['rock'] } },
  }));
  useOnboardingNotice.setState({ notice: null });
}

beforeEach(finishedAllButTaste);

describe('readMissingSteps', () => {
  test.each<[unknown, string[]]>([
    [{ missing: ['consents', 'avatar'] }, ['consents', 'avatar']],
    [{ missing: ['avatar', 42, null] }, ['avatar']],
    [{ missing: 'avatar' }, []],
    [null, []],
    [undefined, []],
    ['oops', []],
  ])('%p → %p', (details, expected) => {
    expect(readMissingSteps(details)).toEqual(expected);
  });
});

describe('409 onboarding_incomplete', () => {
  test('нет аватара: сбрасывается только аватар, шаг — «avatar»', () => {
    expect(rewindToMissingSteps(['avatar'])).toBe(true);
    const s = useSession.getState();
    expect(s.avatarSaved).toBe(false);
    expect(s.draft.avatarUri).toBeNull();
    expect(s.consentsSaved).toBe(true);
    expect(s.draft.name).toBe('Лиза');
    expect(s.draft.taste).toEqual({ genres: ['rock'] });
    expect(selectOnboardingStep(s)).toBe('avatar');
    expect(useOnboardingNotice.getState().notice?.step).toBe('avatar');
  });

  test('нет согласий и аватара: ведём на первый непройденный — согласия', () => {
    expect(rewindToMissingSteps(['avatar', 'consents'])).toBe(true);
    const s = useSession.getState();
    expect(s.consentsSaved).toBe(false);
    expect(s.avatarSaved).toBe(false);
    expect(selectOnboardingStep(s)).toBe('consent');
    expect(useOnboardingNotice.getState().notice?.step).toBe('consent');
  });

  test('неизвестные шаги ничего не трогают', () => {
    expect(rewindToMissingSteps(['location', 'something'])).toBe(false);
    expect(selectOnboardingStep(useSession.getState())).toBe('taste');
    expect(useOnboardingNotice.getState().notice).toBeNull();
  });
});

test('422 name_rejected: имя стирается, шаг — «name», причина показывается', () => {
  rejectName('Имя содержит запрещённое слово');
  const s = useSession.getState();
  expect(s.draft.name).toBeNull();
  expect(selectOnboardingStep(s)).toBe('name');
  expect(useOnboardingNotice.getState().notice).toEqual({
    step: 'name',
    title: 'Это имя нельзя использовать',
    text: 'Имя содержит запрещённое слово',
  });
});

describe('ошибки PUT /me/consents', () => {
  test('403 age_restricted блокирует экран', () => {
    expect(consentsSubmitError(new ApiError(403, 'age_restricted', 'Регистрация с 16 лет'))).toEqual({ kind: 'age' });
  });

  test('409 consents_outdated просит обновить приложение, а не повторять', () => {
    expect(consentsSubmitError(new ApiError(409, 'consents_outdated', 'outdated'))).toEqual({
      kind: 'server',
      message: CONSENTS_OUTDATED_MESSAGE,
    });
  });

  test('нет сети — можно повторить', () => {
    expect(consentsSubmitError(new NetworkError('Нет соединения с сервером'))).toEqual({
      kind: 'network',
      message: 'Нет соединения с сервером. Проверьте интернет и повторите.',
    });
  });
});

describe('ошибки PUT /me/avatar', () => {
  test('409 без согласий: возврат на шаг согласий, сообщения на экране фото нет', () => {
    const err = new ApiError(409, 'onboarding_incomplete', 'Сначала согласия', { missing: ['consents'] });
    expect(avatarUploadError(err)).toBeNull();
    const s = useSession.getState();
    expect(s.consentsSaved).toBe(false);
    expect(selectOnboardingStep(s)).toBe('consent');
    expect(useOnboardingNotice.getState().notice?.step).toBe('consent');
  });

  test('409 с непонятным перечнем шагов не сбрасывает флаги', () => {
    const err = new ApiError(409, 'onboarding_incomplete', 'Сначала согласия', { missing: [] });
    expect(avatarUploadError(err)).toEqual({ kind: 'server', message: 'Сначала согласия' });
    expect(useSession.getState().consentsSaved).toBe(true);
  });

  test.each([413, 422])('%i — снимок не принят, нужен новый', (status) => {
    expect(avatarUploadError(new ApiError(status, 'bad_image', 'bad'))).toEqual({ kind: 'rejected', message: AVATAR_REJECTED_MESSAGE });
  });

  test.each<[unknown, string]>([
    [new NetworkError('Сервер не отвечает'), 'network'],
    [new ApiError(503, 'unavailable', 'down'), 'server'],
    [new ApiError(429, 'rate_limited', 'slow down'), 'server'],
  ])('%s → %s (тот же снимок можно отправить ещё раз)', (err, kind) => {
    expect(avatarUploadError(err)?.kind).toBe(kind);
  });
});
