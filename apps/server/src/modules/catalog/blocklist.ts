/**
 * Блок-лист загрузок по жалобам правообладателей (takedown).
 * Формат: `user:<handle в нижнем регистре>` у Audius или `<trackId>` целиком.
 * Стартовые записи — загрузчики, замеченные с чужими треками при исследовании источников.
 */
export const CATALOG_BLOCKLIST: ReadonlySet<string> = new Set(['user:nikolas1234', 'user:_mad_makc_']);
