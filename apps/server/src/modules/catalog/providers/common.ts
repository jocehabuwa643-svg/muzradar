import type { Track } from '@muzradar/shared';
import { UpstreamError } from '../http.ts';
import type { CatalogProvider, ProviderQuery } from '../types.ts';

/** Короче — это заставки, джинглы и произношения, а не песни. */
export const MIN_TRACK_SEC = 30;
/** Длиннее — многочасовые миксы и записи эфиров. */
export const MAX_TRACK_SEC = 2 * 60 * 60;

/** Сколько просить у источника: часть выдачи отсеют фильтры доступности и легальности. */
export function fetchLimit(query: ProviderQuery, max: number): number {
  return Math.min(max, Math.max(10, query.limit * 2));
}

export function durationOk(sec: number): boolean {
  return sec <= 0 || (sec >= MIN_TRACK_SEC && sec <= MAX_TRACK_SEC);
}

/** Источник ответил «нет такого» — для resolve это null, а не ошибка. */
export function isNotFound(err: unknown): boolean {
  return err instanceof UpstreamError && (err.status === 404 || err.status === 400 || err.status === 410);
}

/** Раздел «Андеграунд» есть не у всех источников. */
export interface UndergroundCapable {
  underground(query: ProviderQuery, signal: AbortSignal): Promise<Track[]>;
}

export function hasUnderground(provider: CatalogProvider): provider is CatalogProvider & UndergroundCapable {
  return typeof (provider as Partial<UndergroundCapable>).underground === 'function';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
