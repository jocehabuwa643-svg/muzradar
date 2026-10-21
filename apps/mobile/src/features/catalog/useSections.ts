import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { selectSections } from './sections';

export const SECTIONS_QUERY_KEY = ['catalog', 'sections'] as const;

export function useSections() {
  return useQuery({
    queryKey: SECTIONS_QUERY_KEY,
    queryFn: ({ signal }) => api.sections(signal),
    select: selectSections,
    staleTime: 5 * 60_000,
  });
}
