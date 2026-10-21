import type { MoodId } from '@muzradar/shared';

/** Значения `mood` у Audius (перечисление из SDK). */
export const AUDIUS_MOODS = [
  'Peaceful',
  'Romantic',
  'Sentimental',
  'Tender',
  'Easygoing',
  'Yearning',
  'Sophisticated',
  'Sensual',
  'Cool',
  'Gritty',
  'Melancholy',
  'Serious',
  'Brooding',
  'Fiery',
  'Defiant',
  'Aggressive',
  'Rowdy',
  'Excited',
  'Energizing',
  'Empowering',
  'Stirring',
  'Upbeat',
  'Other',
] as const;
export type AudiusMood = (typeof AUDIUS_MOODS)[number];

export interface MoodVocabulary {
  audius: {
    moods: readonly AudiusMood[];
    /** Жанры Audius — подсказка для разделов, в фильтр поиска не идут (сузили бы выдачу до пустой). */
    genres: readonly string[];
    bpmMin?: number;
    bpmMax?: number;
  };
  jamendo: {
    fuzzytags: readonly string[];
    speed?: readonly ('verylow' | 'low' | 'medium' | 'high' | 'veryhigh')[];
    vocalinstrumental?: 'vocal' | 'instrumental';
  };
  /** Термины для `subject:(…)` в поиске Internet Archive. */
  archive: readonly string[];
}

/**
 * Настроение → словари провайдеров (таблица из digest music-sources).
 * «drive» — строка «car» таблицы; «morning» в таблице нет — подобрано по тем же словарям.
 * Теги Jamendo не проверены вживую (нужен client_id).
 */
export const MOOD_VOCABULARY: Readonly<Record<MoodId, MoodVocabulary>> = {
  sport: {
    audius: {
      moods: ['Energizing', 'Empowering', 'Aggressive', 'Fiery'],
      genres: ['Electronic', 'Trap', 'Drum & Bass', 'Hardstyle', 'Hip-Hop/Rap'],
      bpmMin: 125,
    },
    jamendo: { fuzzytags: ['energetic', 'workout', 'sport', 'motivational'], speed: ['high', 'veryhigh'] },
    archive: ['electronic', 'techno', 'drum and bass', 'breakbeat'],
  },
  drive: {
    audius: {
      moods: ['Upbeat', 'Cool', 'Excited', 'Rowdy'],
      genres: ['Hip-Hop/Rap', 'Rock', 'Electronic', 'Vaporwave'],
      bpmMin: 95,
      bpmMax: 130,
    },
    jamendo: { fuzzytags: ['driving', 'roadtrip', 'rock', 'upbeat'], speed: ['medium', 'high'] },
    archive: ['rock', 'hip hop', 'synthwave', 'electro'],
  },
  night: {
    audius: {
      moods: ['Brooding', 'Cool', 'Sensual', 'Sophisticated'],
      genres: ['Deep House', 'Downtempo', 'Ambient', 'Lo-Fi', 'Techno'],
    },
    jamendo: { fuzzytags: ['night', 'dark', 'deephouse', 'downtempo', 'ambient'], speed: ['low', 'medium'] },
    archive: ['ambient', 'deep house', 'downtempo', 'dub', 'techno'],
  },
  work: {
    audius: { moods: ['Easygoing', 'Peaceful', 'Sophisticated'], genres: ['Lo-Fi', 'Jazz', 'Acoustic', 'Ambient'] },
    jamendo: { fuzzytags: ['background', 'positive', 'acoustic', 'lounge'], vocalinstrumental: 'instrumental' },
    archive: ['lounge', 'jazz', 'acoustic', 'instrumental'],
  },
  focus: {
    audius: {
      moods: ['Peaceful', 'Serious', 'Easygoing'],
      genres: ['Ambient', 'Lo-Fi', 'Classical', 'Soundtrack'],
      bpmMax: 100,
    },
    jamendo: {
      fuzzytags: ['ambient', 'calm', 'piano', 'minimal', 'study'],
      vocalinstrumental: 'instrumental',
      speed: ['verylow', 'low'],
    },
    archive: ['ambient', 'drone', 'minimal', 'classical', 'piano'],
  },
  chill: {
    audius: {
      moods: ['Easygoing', 'Peaceful', 'Tender', 'Cool'],
      genres: ['Lo-Fi', 'Downtempo', 'Ambient', 'Tropical House'],
      bpmMax: 110,
    },
    jamendo: { fuzzytags: ['chillout', 'relaxing', 'lounge', 'lofi'], speed: ['low', 'medium'] },
    archive: ['chillout', 'chill out', 'lounge', 'downtempo', 'lofi'],
  },
  party: {
    audius: {
      moods: ['Excited', 'Upbeat', 'Rowdy', 'Energizing'],
      genres: ['House', 'Tech House', 'Disco', 'Dancehall', 'Moombahton', 'Jersey Club', 'Future House'],
      bpmMin: 118,
      bpmMax: 132,
    },
    jamendo: { fuzzytags: ['party', 'dance', 'house', 'club', 'happy'], speed: ['high'] },
    archive: ['house', 'dance', 'disco', 'electro'],
  },
  romance: {
    audius: {
      moods: ['Romantic', 'Sensual', 'Tender', 'Yearning'],
      genres: ['R&B/Soul', 'Acoustic', 'Pop', 'Jazz'],
    },
    jamendo: { fuzzytags: ['love', 'romantic', 'soft', 'ballad'] },
    archive: ['love', 'romantic', 'ballad', 'soul'],
  },
  sad: {
    audius: { moods: ['Melancholy', 'Sentimental', 'Yearning', 'Brooding'], genres: [] },
    jamendo: { fuzzytags: ['sad', 'melancholic', 'emotional', 'piano'] },
    archive: ['melancholic', 'melancholy', 'sad', 'dark ambient'],
  },
  morning: {
    audius: {
      moods: ['Upbeat', 'Easygoing', 'Empowering', 'Tender'],
      genres: ['Acoustic', 'Pop', 'Folk', 'Lo-Fi'],
      bpmMin: 90,
      bpmMax: 125,
    },
    jamendo: { fuzzytags: ['morning', 'positive', 'happy', 'acoustic'], speed: ['medium'] },
    archive: ['acoustic', 'folk', 'indie pop', 'happy'],
  },
};

export function moodVocabulary(mood: MoodId): MoodVocabulary {
  return MOOD_VOCABULARY[mood];
}

/** Уникальные значения по порядку первого появления. */
export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}
