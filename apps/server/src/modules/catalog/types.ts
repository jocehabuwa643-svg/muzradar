import type { GenreId, MoodId, ProviderId, Track } from '@muzradar/shared';

export interface ProviderQuery {
  /** Свободный текст поиска. */
  text?: string;
  genres?: readonly GenreId[];
  moods?: readonly MoodId[];
  /** ru — только русскоязычное; foreign — без русскоязычного; null — всё. */
  language?: 'ru' | 'foreign' | null;
  sort?: 'popular' | 'recent' | 'relevant';
  limit: number;
  offset?: number;
}

/**
 * Источник треков. Возвращает только легально воспроизводимое (`full`/`preview`);
 * `unavailable` отфильтровывается внутри провайдера.
 */
export interface CatalogProvider {
  readonly id: ProviderId;
  /** false — провайдер не настроен (нет ключа) и пропускается. */
  readonly enabled: boolean;
  search(query: ProviderQuery, signal: AbortSignal): Promise<Track[]>;
  trending(query: ProviderQuery, signal: AbortSignal): Promise<Track[]>;
  latest(query: ProviderQuery, signal: AbortSignal): Promise<Track[]>;
  /** Трек по id провайдера со свежей ссылкой на поток; null — нет или недоступен. */
  resolve(externalId: string, signal: AbortSignal): Promise<Track | null>;
}
