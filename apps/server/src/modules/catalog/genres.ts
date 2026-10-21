import type { GenreId } from '@muzradar/shared';

export interface GenreVocabulary {
  /** Значения `genre` у Audius (перечисление из SDK). */
  audius: readonly string[];
  /** Теги Jamendo (`fuzzytags`). */
  jamendo: readonly string[];
  /** Термины для `subject:(…)` в Internet Archive. */
  archive: readonly string[];
  /** Жанр по сути русскоязычный: провайдеру дополнительно передаётся язык. */
  russian?: boolean;
}

/**
 * Наш жанр → словари провайдеров. У Audius нет фонка, K-pop, эстрады и шансона —
 * берём ближайшие жанры, точность добирает текстовый запрос и язык.
 */
export const GENRE_VOCABULARY: Readonly<Record<GenreId, GenreVocabulary>> = {
  pop: { audius: ['Pop', 'Hyperpop'], jamendo: ['pop'], archive: ['pop', 'indie pop', 'synthpop'] },
  hiphop: { audius: ['Hip-Hop/Rap'], jamendo: ['hiphop', 'rap'], archive: ['hip hop', 'hip-hop', 'rap'] },
  rock: { audius: ['Rock', 'Alternative'], jamendo: ['rock'], archive: ['rock', 'alternative rock'] },
  russian_rock: {
    audius: ['Rock', 'Alternative'],
    jamendo: ['rock'],
    archive: ['russian rock', 'русский рок', 'rock'],
    russian: true,
  },
  indie: { audius: ['Alternative', 'Pop'], jamendo: ['indie'], archive: ['indie', 'indie rock', 'indie pop'] },
  electronic: {
    audius: ['Electronic', 'Electro', 'Future Bass', 'Glitch Hop'],
    jamendo: ['electronic'],
    archive: ['electronic', 'electronica', 'idm'],
  },
  house: {
    audius: ['House', 'Deep House', 'Tech House', 'Progressive House', 'Future House', 'Tropical House'],
    jamendo: ['house'],
    archive: ['house', 'deep house'],
  },
  techno: { audius: ['Techno'], jamendo: ['techno'], archive: ['techno', 'minimal techno'] },
  dnb: { audius: ['Drum & Bass', 'Jungle'], jamendo: ['drumnbass'], archive: ['drum and bass', 'drum & bass', 'jungle'] },
  phonk: { audius: ['Trap', 'Hip-Hop/Rap'], jamendo: ['phonk', 'trap'], archive: ['phonk'] },
  trap: { audius: ['Trap'], jamendo: ['trap'], archive: ['trap'] },
  rnb: { audius: ['R&B/Soul'], jamendo: ['rnb', 'soul'], archive: ['rnb', 'r&b', 'soul'] },
  jazz: { audius: ['Jazz'], jamendo: ['jazz'], archive: ['jazz'] },
  blues: { audius: ['Blues'], jamendo: ['blues'], archive: ['blues'] },
  classical: { audius: ['Classical'], jamendo: ['classical'], archive: ['classical'] },
  soundtrack: { audius: ['Soundtrack'], jamendo: ['soundtrack'], archive: ['soundtrack', 'cinematic'] },
  metal: { audius: ['Metal'], jamendo: ['metal'], archive: ['metal'] },
  punk: { audius: ['Punk'], jamendo: ['punk'], archive: ['punk'] },
  folk: { audius: ['Folk', 'Acoustic', 'Country'], jamendo: ['folk'], archive: ['folk'] },
  reggae: { audius: ['Reggae', 'Dancehall'], jamendo: ['reggae'], archive: ['reggae', 'dub'] },
  latin: { audius: ['Latin', 'Moombahton'], jamendo: ['latin'], archive: ['latin'] },
  kpop: { audius: ['Pop'], jamendo: ['kpop'], archive: ['k-pop'] },
  lofi: { audius: ['Lo-Fi'], jamendo: ['lofi'], archive: ['lo-fi', 'lofi'] },
  ambient: { audius: ['Ambient', 'Downtempo'], jamendo: ['ambient'], archive: ['ambient'] },
  estrada: { audius: ['Pop'], jamendo: ['pop'], archive: ['estrada', 'эстрада'], russian: true },
  chanson: { audius: ['Folk', 'Pop'], jamendo: ['chanson'], archive: ['chanson', 'шансон'], russian: true },
};

export function genreVocabulary(genre: GenreId): GenreVocabulary {
  return GENRE_VOCABULARY[genre];
}

/** Не музыка: подкасты и начитка попадают в поиск Audius и засоряют витрину. */
export const AUDIUS_NON_MUSIC_GENRES: ReadonlySet<string> = new Set([
  'Podcasts',
  'Audiobooks',
  'Spoken Word',
  'Comedy',
  'Kids',
  'Devotional',
]);
