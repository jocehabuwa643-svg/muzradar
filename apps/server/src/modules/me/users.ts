import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { users, type UserRow } from '../../db/schema.ts';
import { HttpError, httpError } from '../../plugins/errors.ts';

/** Пользователь из токена. Удалённый аккаунт — 401: токен живёт до 15 минут после удаления. */
export async function loadActiveUser(db: Db, id: string): Promise<UserRow> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  if (!user) throw httpError.unauthorized();
  return user;
}

export type OnboardingStep = 'consents' | 'avatar';

/** Клиент по `details.missing` возвращает пользователя на первый непройденный шаг. */
export function onboardingIncomplete(missing: OnboardingStep[]): HttpError {
  return new HttpError(409, 'onboarding_incomplete', 'Сначала пройдите предыдущие шаги', { missing });
}
