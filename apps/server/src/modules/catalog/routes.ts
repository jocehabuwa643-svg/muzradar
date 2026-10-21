import {
  ArtistSuggestionsResponse,
  GENRE_IDS,
  LIMITS,
  MOOD_IDS,
  SearchQuery,
  SectionsResponse,
  Track,
  TrackId,
  TracksResponse,
  type GenreId,
  type MoodId,
  type Taste,
} from '@muzradar/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TasteJson } from '../../db/schema.ts';
import { httpError } from '../../plugins/errors.ts';
import { loadActiveUser } from '../me/users.ts';
import { buildProviders } from './providers/index.ts';
import { CatalogService } from './service.ts';
import { buildSimilarArtists, type SimilarArtistsSource } from './similar.ts';
import type { CatalogProvider } from './types.ts';

export interface CatalogRoutesOptions {
  providers?: CatalogProvider[];
  similar?: SimilarArtistsSource;
}

/** `genres=rock,indie` — список выбранных жанров онбординга. */
const ArtistsQuery = z.object({
  genres: z
    .string()
    .max(400)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    )
    .pipe(z.array(z.enum(GENRE_IDS)).min(1).max(GENRE_IDS.length))
    .optional(),
});

const GENRE_SET: ReadonlySet<string> = new Set(GENRE_IDS);
const MOOD_SET: ReadonlySet<string> = new Set(MOOD_IDS);

/** Вкус из БД мог быть записан старой версией приложения: неизвестные значения отбрасываем. */
function toTaste(raw: TasteJson | null): Taste {
  return {
    genres: (raw?.genres ?? []).filter((g): g is GenreId => GENRE_SET.has(g)).slice(0, LIMITS.tasteGenresMax),
    moods: (raw?.moods ?? []).filter((m): m is MoodId => MOOD_SET.has(m)),
    artists: (raw?.artists ?? []).slice(0, LIMITS.tasteArtistsMax),
  };
}

/**
 * Идентификатор из пути. У Internet Archive он содержит «/», поэтому маршрут — со звёздочкой;
 * клиент может прислать слэш как есть или в виде %2F.
 */
function pathTrackId(raw: string): string | null {
  const candidates = [raw];
  if (raw.includes('%')) {
    try {
      candidates.push(decodeURIComponent(raw));
    } catch {
      // битая percent-последовательность — просто не кандидат
    }
  }
  return candidates.find((c) => TrackId.safeParse(c).success) ?? null;
}

const routes: FastifyPluginAsyncZod<CatalogRoutesOptions> = async (app, opts) => {
  const providers = opts.providers ?? buildProviders(app.config, () => app.now());
  const similar = opts.similar ?? buildSimilarArtists(app.config, () => app.now());
  const service = new CatalogService({ providers, similar, now: () => app.now() });

  app.get('/sections', { onRequest: [app.requireOnboarded], schema: { response: { 200: SectionsResponse } } }, async (req) => {
    const user = await loadActiveUser(app.db, req.user.sub);
    return { sections: await service.sections(toTaste(user.taste)) };
  });

  app.get(
    '/search',
    {
      onRequest: [app.requireOnboarded],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { querystring: SearchQuery, response: { 200: TracksResponse } },
    },
    async (req) => ({ tracks: await service.search(req.query.q, req.query.limit) }),
  );

  app.get('/tracks/*', { onRequest: [app.requireOnboarded], schema: { response: { 200: Track } } }, async (req) => {
    const raw = (req.params as Record<string, string | undefined>)['*'] ?? '';
    const id = pathTrackId(raw);
    // Неизвестный формат id для клиента неотличим от исчезнувшего трека — оба 404.
    if (!id) throw httpError.notFound('track_not_found', 'Трек не найден');
    const track = await service.resolve(id);
    if (!track || track.playback === 'unavailable') throw httpError.notFound('track_not_found', 'Трек не найден');
    return track;
  });

  // Подсказки артистов нужны ещё на онбординге, до выдачи «онбординг пройден».
  app.get(
    '/artists',
    { onRequest: [app.authenticate], schema: { querystring: ArtistsQuery, response: { 200: ArtistSuggestionsResponse } } },
    async (req) => ({ artists: service.artists(req.query.genres ?? []) }),
  );
};

export default routes;
