import { create } from 'zustand';
import { ApiError, NetworkError } from '@/lib/api';
import { useSession, type OnboardingStep } from '@/state/session';

export interface StepNotice {
  step: OnboardingStep;
  title: string;
  text: string;
}

/**
 * Разовое сообщение для шага, на который вернул сервер: без него человек увидел бы
 * уже пройденный экран и не понял бы, почему. Не сохраняется — после перезапуска не нужно.
 */
export const useOnboardingNotice = create<{ notice: StepNotice | null }>(() => ({ notice: null }));

export function showStepNotice(notice: StepNotice | null): void {
  useOnboardingNotice.setState({ notice });
}

export function useStepNotice(step: OnboardingStep): { notice: StepNotice | null; dismiss: () => void } {
  const notice = useOnboardingNotice((s) => (s.notice?.step === step ? s.notice : null));
  return { notice, dismiss: () => showStepNotice(null) };
}

/** `details.missing` из ответа 409 onboarding_incomplete. */
export function readMissingSteps(details: unknown): string[] {
  if (!details || typeof details !== 'object') return [];
  const missing = (details as { missing?: unknown }).missing;
  return Array.isArray(missing) ? missing.filter((m): m is string => typeof m === 'string') : [];
}

const REWIND_NOTICES: Partial<Record<OnboardingStep, Omit<StepNotice, 'step'>>> = {
  consent: { title: 'Согласия не сохранились', text: 'Отметьте их ещё раз — без них профиль не создать.' },
  name: { title: 'Имя не сохранилось', text: 'Введите его ещё раз.' },
  avatar: { title: 'Фото не сохранилось', text: 'Сделайте снимок ещё раз — это займёт пару секунд.' },
};

/**
 * Сбрасывает в сессии флаги шагов, которые сервер считает непройденными; guard онбординга
 * сам переведёт на первый из них. Возвращает false, если ни один шаг не распознан.
 */
export function rewindToMissingSteps(missing: readonly string[]): boolean {
  const set = new Set(missing);
  const consents = set.has('consents') || set.has('consent') || set.has('birthYear');
  const name = set.has('name');
  const avatar = set.has('avatar');
  if (!consents && !name && !avatar) return false;

  useSession.setState((s) => ({
    ...(consents ? { consentsSaved: false } : {}),
    ...(avatar ? { avatarSaved: false } : {}),
    draft: {
      ...s.draft,
      ...(name ? { name: null } : {}),
      ...(avatar ? { avatarUri: null } : {}),
    },
  }));

  const first: OnboardingStep = consents ? 'consent' : name ? 'name' : 'avatar';
  const copy = REWIND_NOTICES[first];
  showStepNotice(copy ? { step: first, ...copy } : null);
  return true;
}

/** 422 name_rejected: имя не прошло серверный фильтр — возвращаем на шаг имени с причиной. */
export function rejectName(serverMessage: string | null): void {
  useSession.getState().updateDraft({ name: null });
  showStepNotice({
    step: 'name',
    title: 'Это имя нельзя использовать',
    text: serverMessage && serverMessage.trim() ? serverMessage : 'Выберите другое — без оскорблений и ссылок.',
  });
}

/** Текст ошибки запроса шага для человека: без кодов и английского. */
export function requestErrorMessage(err: unknown): string {
  if (err instanceof NetworkError) return `${err.message}. Проверьте интернет и повторите.`;
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Слишком много попыток. Подождите минуту и повторите.';
    if (err.status >= 500) return 'Сервер временно недоступен. Попробуйте ещё раз.';
    return err.message;
  }
  return 'Что-то пошло не так. Попробуйте ещё раз.';
}

/** network — повтор поможет; server — повтор вряд ли поможет; rejected — нужен другой ввод. */
export type StepError = { kind: 'network' | 'server' | 'rejected'; message: string };

const asStepError = (err: unknown): StepError => ({
  kind: err instanceof NetworkError ? 'network' : 'server',
  message: requestErrorMessage(err),
});

export const CONSENTS_OUTDATED_MESSAGE = 'Тексты согласий обновились. Обновите приложение, чтобы принять актуальную версию.';

/** Ошибка PUT /me/consents: `age` — отказ по возрасту, экран блокируется. */
export function consentsSubmitError(err: unknown): { kind: 'age' } | StepError {
  if (err instanceof ApiError && err.status === 403 && err.code === 'age_restricted') return { kind: 'age' };
  // версии документов в приложении старее серверных — повтором это не исправить
  if (err instanceof ApiError && err.status === 409 && err.code === 'consents_outdated') {
    return { kind: 'server', message: CONSENTS_OUTDATED_MESSAGE };
  }
  return asStepError(err);
}

export const AVATAR_REJECTED_MESSAGE = 'Сервер не принял фото — переснимите, пожалуйста.';

/**
 * Ошибка PUT /me/avatar. null — сервер считает непройденным более ранний шаг (согласия):
 * флаги уже сброшены, guard сам уведёт туда, показывать на этом экране нечего.
 */
export function avatarUploadError(err: unknown): StepError | null {
  if (err instanceof ApiError && err.status === 409 && err.code === 'onboarding_incomplete') {
    if (rewindToMissingSteps(readMissingSteps(err.details))) return null;
  }
  // 413/422 и прочие отказы по содержимому: тот же снимок снова не пройдёт
  if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![401, 409, 429].includes(err.status)) {
    return { kind: 'rejected', message: AVATAR_REJECTED_MESSAGE };
  }
  return asStepError(err);
}
