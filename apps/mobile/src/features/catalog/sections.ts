import type { Section, SectionsResponse } from '@muzradar/shared';
import { canList } from './playable';

/**
 * Порядок разделов — серверный; пустые после фильтрации не показываем.
 * Исключение — раздел с пометкой сервера («Источник временно недоступен»): он не должен молча исчезать.
 */
export function selectSections(data: SectionsResponse): Section[] {
  return data.sections
    .map((s) => ({ ...s, tracks: s.tracks.filter(canList) }))
    .filter((s) => s.tracks.length > 0 || !!s.notice);
}
