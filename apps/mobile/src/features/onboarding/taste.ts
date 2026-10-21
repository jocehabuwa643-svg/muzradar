import { GENRE_IDS, LIMITS, MOOD_IDS, Taste, type GenreId, type MoodId } from '@muzradar/shared';

export interface TasteDraft {
  genres: GenreId[];
  moods: MoodId[];
  artists: string[];
}

const ARTIST_NAME_MAX = 80;

const genreSet = new Set<string>(GENRE_IDS);
const moodSet = new Set<string>(MOOD_IDS);

const isGenre = (v: unknown): v is GenreId => typeof v === 'string' && genreSet.has(v);
const isMood = (v: unknown): v is MoodId => typeof v === 'string' && moodSet.has(v);

/** Черновик из сохранённого состояния: выкидывает жанры и настроения, которых больше нет в справочнике. */
export function tasteFromDraft(partial: Partial<Taste> | undefined): TasteDraft {
  let artists: string[] = [];
  for (const raw of partial?.artists ?? []) {
    const r = addArtist(artists, raw);
    if (r.error === null) artists = r.next;
  }
  return {
    genres: unique((partial?.genres ?? []).filter(isGenre)).slice(0, LIMITS.tasteGenresMax),
    moods: unique((partial?.moods ?? []).filter(isMood)),
    artists,
  };
}

function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

export interface ToggleResult<T> {
  next: T[];
  /** Выбор упёрся в лимит — список не изменился. */
  limited: boolean;
}

export function toggleGenre(list: readonly GenreId[], id: GenreId): ToggleResult<GenreId> {
  if (list.includes(id)) return { next: list.filter((g) => g !== id), limited: false };
  if (list.length >= LIMITS.tasteGenresMax) return { next: [...list], limited: true };
  return { next: [...list, id], limited: false };
}

export function toggleMood(list: readonly MoodId[], id: MoodId): MoodId[] {
  return list.includes(id) ? list.filter((m) => m !== id) : [...list, id];
}

export function normalizeArtistName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

const sameArtist = (a: string, b: string) => a.toLocaleLowerCase('ru') === b.toLocaleLowerCase('ru');

export type AddArtistError = 'empty' | 'too-long' | 'duplicate' | 'limit';

export function addArtist(list: readonly string[], raw: string): { next: string[]; error: AddArtistError | null } {
  const name = normalizeArtistName(raw);
  if (!name) return { next: [...list], error: 'empty' };
  if (name.length > ARTIST_NAME_MAX) return { next: [...list], error: 'too-long' };
  if (list.some((a) => sameArtist(a, name))) return { next: [...list], error: 'duplicate' };
  if (list.length >= LIMITS.tasteArtistsMax) return { next: [...list], error: 'limit' };
  return { next: [...list, name], error: null };
}

export function toggleArtist(list: readonly string[], name: string): { next: string[]; error: AddArtistError | null } {
  if (list.some((a) => sameArtist(a, name))) return { next: list.filter((a) => !sameArtist(a, name)), error: null };
  return addArtist(list, name);
}

export const hasArtist = (list: readonly string[], name: string) => list.some((a) => sameArtist(a, name));

export const ADD_ARTIST_ERRORS: Record<AddArtistError, string> = {
  empty: 'Введите имя артиста',
  'too-long': `Не длиннее ${ARTIST_NAME_MAX} символов`,
  duplicate: 'Этот артист уже в списке',
  limit: `Максимум ${LIMITS.tasteArtistsMax} артистов`,
};

export interface TasteCheck {
  genres: { count: number; ok: boolean; atMax: boolean };
  moods: { count: number; ok: boolean };
  artists: { count: number; ok: boolean; atMax: boolean };
  /** Готовый к отправке вкус (прошёл общую схему) или null. */
  taste: Taste | null;
  /** Что ещё сделать — одной фразой для подсказки над кнопкой. */
  hint: string | null;
}

export function checkTaste(draft: TasteDraft): TasteCheck {
  const g = draft.genres.length;
  const m = draft.moods.length;
  const a = draft.artists.length;
  const genresOk = g >= LIMITS.tasteGenresMin && g <= LIMITS.tasteGenresMax;
  const moodsOk = m >= LIMITS.tasteMoodsMin;
  const artistsOk = a >= LIMITS.tasteArtistsMin && a <= LIMITS.tasteArtistsMax;
  const parsed = genresOk && moodsOk && artistsOk ? Taste.safeParse(draft) : null;
  let hint: string | null = null;
  if (!genresOk && g < LIMITS.tasteGenresMin) {
    const left = LIMITS.tasteGenresMin - g;
    hint = `Выберите ещё ${left} ${plural(left, ['жанр', 'жанра', 'жанров'])}`;
  } else if (!moodsOk) hint = 'Выберите хотя бы одно настроение';
  else if (!artistsOk && a < LIMITS.tasteArtistsMin) hint = 'Добавьте хотя бы одного артиста';
  return {
    genres: { count: g, ok: genresOk, atMax: g >= LIMITS.tasteGenresMax },
    moods: { count: m, ok: moodsOk },
    artists: { count: a, ok: artistsOk, atMax: a >= LIMITS.tasteArtistsMax },
    taste: parsed?.success ? parsed.data : null,
    hint,
  };
}

/** Русское множественное число: 1 жанр, 2 жанра, 5 жанров, 11 жанров, 21 жанр. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
