import { GENRE_IDS, MOOD_IDS, Taste, type Me } from '@muzradar/shared';
import type { Config } from '../../config.ts';
import type { TasteJson, UserRow } from '../../db/schema.ts';
import { avatarUrl } from '../../types.ts';

const KNOWN_GENRES = new Set<string>(GENRE_IDS);
const KNOWN_MOODS = new Set<string>(MOOD_IDS);

/**
 * Вкус из БД → контракт. Справочники жанров и настроений могут сократиться,
 * а ответ сериализуется строгой схемой: неизвестные id отбрасываем, иначе
 * один устаревший жанр ронял бы GET /v1/me в 500.
 */
export function toTaste(taste: TasteJson | null | undefined): Taste | null {
  if (!taste) return null;
  const parsed = Taste.safeParse({
    genres: (taste.genres ?? []).filter((g) => KNOWN_GENRES.has(g)),
    moods: (taste.moods ?? []).filter((m) => KNOWN_MOODS.has(m)),
    artists: taste.artists ?? [],
  });
  return parsed.success ? parsed.data : null;
}

export function toMe(user: UserRow, config: Pick<Config, 'assetsBaseUrl'>): Me {
  return {
    id: user.id,
    name: user.name,
    birthYear: user.birthYear,
    avatarUrl: user.avatarHash ? avatarUrl(config, user.avatarHash, 'full') : null,
    mapAvatarUrl: user.avatarHash ? avatarUrl(config, user.avatarHash, 'map') : null,
    taste: toTaste(user.taste),
    visibility: user.visibility,
    consentsVersion: user.consentsVersion,
    onboardedAt: user.onboardedAt ? user.onboardedAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
