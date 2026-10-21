import type { Track } from '@muzradar/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { canList } from './playable';

export const SEARCH_DEBOUNCE_MS = 350;
/** Однобуквенный запрос бесполезен, а квоты источников (Jamendo — 35 000 в месяц) конечны. */
export const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 25;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface SearchState {
  /** Пользователь что-то ввёл: вместо витрины показываем поиск. */
  active: boolean;
  /** Запрос, по которому получены результаты (после паузы в наборе). */
  query: string;
  tooShort: boolean;
  /** Набор ещё идёт — результаты от предыдущего запроса. */
  typing: boolean;
  tracks: Track[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}

export function useSearch(input: string): SearchState {
  const trimmed = input.trim();
  const query = useDebouncedValue(trimmed, SEARCH_DEBOUNCE_MS);
  const enabled = query.length >= SEARCH_MIN_CHARS;

  const result = useQuery({
    queryKey: ['catalog', 'search', query],
    queryFn: async ({ signal }) => (await api.search(query, SEARCH_LIMIT, signal)).tracks.filter(canList),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  return {
    active: trimmed.length > 0,
    query,
    tooShort: trimmed.length > 0 && trimmed.length < SEARCH_MIN_CHARS,
    typing: trimmed !== query,
    tracks: enabled ? (result.data ?? []) : [],
    loading: enabled && result.isPending,
    error: enabled && result.isError && result.data === undefined,
    retry: () => void result.refetch(),
  };
}
