import { LEGAL_VERSIONS, LIMITS, type Consents, type DisseminationScope, type Visibility } from '@muzradar/shared';

/**
 * Без имени, фото или приблизительного места точку на карте не нарисовать, а показывать
 * «кусок» человека без согласия нельзя (152-ФЗ ст. 10.1). Оператор обязан принять
 * ограниченное согласие — поэтому такой пользователь не отклоняется, а становится невидимкой.
 */
const MAP_SCOPE: readonly DisseminationScope[] = ['name', 'avatar', 'location'];

/** Возраст по году рождения — так же, как его считает birthYearBounds() для порога в 16 лет. */
export function ageByYear(birthYear: number, now: Date): number {
  return now.getUTCFullYear() - birthYear;
}

export function resolveVisibility(birthYear: number, scope: readonly DisseminationScope[], now: Date): Visibility {
  const granted = new Set(scope);
  if (!MAP_SCOPE.every((s) => granted.has(s))) return 'ghost';
  if (ageByYear(birthYear, now) < LIMITS.adultAge) return 'followers';
  return 'public';
}

export function isCurrentVersion(consents: Consents): boolean {
  return (
    consents.processing.version === LEGAL_VERSIONS.processing &&
    consents.dissemination.version === LEGAL_VERSIONS.dissemination &&
    consents.rules.version === LEGAL_VERSIONS.rules
  );
}
