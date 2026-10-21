import { birthYearBounds, ConsentsInput, LEGAL_VERSIONS, LIMITS, type DisseminationScope } from '@muzradar/shared';

export type ConsentKey = keyof typeof LEGAL_VERSIONS;

export const CONSENT_KEYS: readonly ConsentKey[] = ['processing', 'dissemination', 'rules'];

/** Что увидят другие: имя, фото, текущий трек и приблизительное место — ровно то, что перечислено в тексте галочки. */
export const DISSEMINATION_SCOPE: readonly DisseminationScope[] = ['name', 'avatar', 'track', 'location'];

export const LEGAL_URLS: Record<ConsentKey, string> = {
  processing: 'https://muzradar.app/legal/processing',
  dissemination: 'https://muzradar.app/legal/dissemination',
  rules: 'https://muzradar.app/legal/rules',
};

export type BirthYearCheck =
  | { status: 'empty' }
  | { status: 'incomplete' }
  | { status: 'invalid'; message: string }
  | { status: 'underage'; message: string }
  | { status: 'ok'; year: number; /** 16–17 лет: видимость только для взаимных подписок. */ minor: boolean };

export const UNDERAGE_MESSAGE = `МУЗРАДАР доступен с ${LIMITS.minAge} лет`;

/** Проверка ввода года рождения; границы — те же, что у сервера (birthYearBounds). */
export function checkBirthYear(input: string, now: Date = new Date()): BirthYearCheck {
  const value = input.trim();
  if (value === '') return { status: 'empty' };
  if (!/^\d+$/.test(value)) return { status: 'invalid', message: 'Только цифры, например 2001' };
  if (value.length < 4) return { status: 'incomplete' };
  if (value.length > 4) return { status: 'invalid', message: 'Год — это четыре цифры' };
  const year = Number(value);
  const current = now.getUTCFullYear();
  const { min, max } = birthYearBounds(now);
  if (year > current) return { status: 'invalid', message: 'Этот год ещё не наступил' };
  if (year > max) return { status: 'underage', message: UNDERAGE_MESSAGE };
  if (year < min) return { status: 'invalid', message: 'Проверьте год рождения' };
  return { status: 'ok', year, minor: current - year < LIMITS.adultAge };
}

/** Момент, когда отметили каждую галочку; null — не отмечена. Снятая галочка теряет время. */
export type AcceptedAt = Record<ConsentKey, string | null>;

export const NO_CONSENTS: AcceptedAt = { processing: null, dissemination: null, rules: null };

export function toggleConsent(accepted: AcceptedAt, key: ConsentKey, now: Date = new Date()): AcceptedAt {
  return { ...accepted, [key]: accepted[key] ? null : now.toISOString() };
}

export function allConsentsGiven(accepted: AcceptedAt): boolean {
  return CONSENT_KEYS.every((k) => accepted[k] !== null);
}

export function canSubmitConsents(year: BirthYearCheck, accepted: AcceptedAt): boolean {
  return year.status === 'ok' && allConsentsGiven(accepted);
}

/**
 * Тело PUT /me/consents. null — пока чего-то не хватает: молчание согласием не считается,
 * поэтому неотмеченная галочка никогда не превращается в согласие по умолчанию.
 */
export function buildConsentsInput(birthYear: number, accepted: AcceptedAt): ConsentsInput | null {
  const { processing, dissemination, rules } = accepted;
  if (!processing || !dissemination || !rules) return null;
  const parsed = ConsentsInput.safeParse({
    birthYear,
    consents: {
      processing: { version: LEGAL_VERSIONS.processing, acceptedAt: processing },
      dissemination: { version: LEGAL_VERSIONS.dissemination, acceptedAt: dissemination, scope: [...DISSEMINATION_SCOPE] },
      rules: { version: LEGAL_VERSIONS.rules, acceptedAt: rules },
    },
  });
  return parsed.success ? parsed.data : null;
}
