import type { Track } from '@muzradar/shared';
import { z } from 'zod';
import { GENRE_VOCABULARY } from '../genres.ts';
import { lenientArray, looseString, UpstreamError, type HttpClient } from '../http.ts';
import { MOOD_VOCABULARY, uniq } from '../moods.ts';
import type { CatalogProvider, ProviderQuery } from '../types.ts';
import { durationOk, fetchLimit } from './common.ts';

export const JAMENDO_API = 'https://api.jamendo.com/v3.0';

const JamendoTrack = z.object({
  id: looseString.pipe(z.string().regex(/^\d{1,12}$/)),
  name: z.string(),
  duration: z.coerce.number().catch(0),
  artist_name: z.string().nullish(),
  album_name: z.string().nullish(),
  album_image: z.string().nullish(),
  image: z.string().nullish(),
  audio: z.string().nullish(),
  license_ccurl: z.string().nullish(),
  shareurl: z.string().nullish(),
  musicinfo: z
    .object({
      lang: z.string().nullish(),
      tags: z.object({ genres: z.array(z.string()).catch([]) }).partial().nullish(),
    })
    .partial()
    .nullish()
    .catch(null),
});
export type JamendoTrack = z.infer<typeof JamendoTrack>;

const JamendoResponse = z.object({
  headers: z.object({
    status: z.string(),
    code: z.coerce.number().nullish(),
    error_message: z.string().nullish(),
  }),
  results: lenientArray(JamendoTrack),
});

export interface JamendoProviderOptions {
  http: HttpClient;
  clientId: string | undefined;
}

/**
 * Jamendo: полные CC-треки. Работает только с client_id; ошибки приходят с HTTP 200,
 * поэтому решает `headers.status` в теле, а не код ответа.
 */
export class JamendoProvider implements CatalogProvider {
  readonly id = 'jamendo' as const;
  readonly enabled: boolean;
  private readonly http: HttpClient;
  private readonly clientId: string | undefined;

  constructor(opts: JamendoProviderOptions) {
    this.http = opts.http;
    this.clientId = opts.clientId;
    this.enabled = !!opts.clientId;
  }

  toTrack(t: JamendoTrack): Track | null {
    const audio = t.audio?.trim();
    // Пустой audio — автор запретил стриминг: такой трек не показываем.
    if (!audio) return null;
    if (!durationOk(t.duration)) return null;
    return {
      id: `jamendo:${t.id}`,
      provider: 'jamendo',
      title: t.name.trim(),
      artist: t.artist_name?.trim() || 'Jamendo',
      album: t.album_name?.trim() || null,
      artworkUrl: t.image || t.album_image || null,
      durationSec: Math.max(0, t.duration),
      playback: 'full',
      previewSec: null,
      genres: t.musicinfo?.tags?.genres ?? [],
      isrc: null,
      licenseUrl: t.license_ccurl || null,
      streamUrl: audio,
      pageUrl: t.shareurl || null,
    };
  }

  private async call(params: Record<string, string>, query: ProviderQuery | null, signal: AbortSignal): Promise<Track[]> {
    if (!this.clientId) return [];
    const sp = new URLSearchParams({
      client_id: this.clientId,
      format: 'json',
      audioformat: 'mp32',
      include: 'musicinfo licenses',
      type: 'single albumtrack',
      imagesize: '300',
      ...params,
    });
    const res = await this.http.getJson(`${JAMENDO_API}/tracks/?${sp}`, JamendoResponse, signal);
    if (res.headers.status !== 'success') {
      throw new UpstreamError(
        'api.jamendo.com',
        200,
        `jamendo: code ${res.headers.code ?? '?'} ${res.headers.error_message ?? ''}`.trim(),
      );
    }
    let items = res.results;
    // lang=ru фильтрует сам API; «зарубежное» отсекаем по musicinfo.lang.
    if (query?.language === 'foreign') items = items.filter((t) => t.musicinfo?.lang !== 'ru');
    const tracks = items.map((t) => this.toTrack(t)).filter((t): t is Track => t !== null);
    return query ? tracks.slice(0, query.limit) : tracks;
  }

  private params(query: ProviderQuery, order: string | null): Record<string, string> {
    const p: Record<string, string> = {
      limit: String(fetchLimit(query, 50)),
      offset: String(query.offset ?? 0),
    };
    const tags = uniq([
      ...(query.genres ?? []).flatMap((g) => GENRE_VOCABULARY[g].jamendo),
      ...(query.moods ?? []).flatMap((m) => MOOD_VOCABULARY[m].jamendo.fuzzytags),
    ]);
    if (tags.length > 0) p.fuzzytags = tags.join(' ');
    const [mood] = query.moods ?? [];
    if (mood && query.moods?.length === 1) {
      const vocab = MOOD_VOCABULARY[mood].jamendo;
      if (vocab.speed) p.speed = vocab.speed.join(' ');
      if (vocab.vocalinstrumental) p.vocalinstrumental = vocab.vocalinstrumental;
    }
    const russian = query.language === 'ru' || (query.genres ?? []).some((g) => GENRE_VOCABULARY[g].russian);
    if (russian) p.lang = 'ru';
    if (query.text) p.search = query.text;
    if (order) p.order = order;
    // Витрины без поиска — по одному треку на артиста, иначе один альбом забивает раздел.
    if (!query.text) p.groupby = 'artist_id';
    return p;
  }

  search(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    const order = query.sort === 'recent' ? 'releasedate_desc' : query.sort === 'popular' ? 'popularity_week' : query.text ? 'relevance' : null;
    return this.call(this.params(query, order), query, signal);
  }

  trending(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    return this.call(this.params(query, 'popularity_week'), query, signal);
  }

  latest(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    return this.call(this.params(query, 'releasedate_desc'), query, signal);
  }

  async resolve(externalId: string, signal: AbortSignal): Promise<Track | null> {
    if (!/^\d{1,12}$/.test(externalId)) return null;
    const [track] = await this.call({ id: externalId }, null, signal);
    return track ?? null;
  }
}
