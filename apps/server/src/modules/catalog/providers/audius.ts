import type { Playback, Track } from '@muzradar/shared';
import { z } from 'zod';
import { CATALOG_BLOCKLIST } from '../blocklist.ts';
import { AUDIUS_NON_MUSIC_GENRES, GENRE_VOCABULARY } from '../genres.ts';
import { lenientArray, looseString, type HttpClient } from '../http.ts';
import { MOOD_VOCABULARY, uniq } from '../moods.ts';
import { interleave, markVerified, matchesLanguage, parseTitle, sameArtist, splitArtistTitle } from '../normalize.ts';
import type { CatalogProvider, ProviderQuery } from '../types.ts';
import { durationOk, fetchLimit, isNotFound, type UndergroundCapable } from './common.ts';

export const AUDIUS_API = 'https://api.audius.co/v1';
export const OML_URL = 'https://openaudiofoundation.org/open-music-license.pdf';
/** Отрывки у Audius — 30 с. */
export const AUDIUS_PREVIEW_SEC = 30;

const AudiusUser = z.object({
  id: looseString,
  handle: z.string().nullish(),
  name: z.string().nullish(),
  is_verified: z.boolean().nullish(),
});

const AudiusTrack = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{1,32}$/),
  title: z.string(),
  duration: z.number().nullish(),
  genre: z.string().nullish(),
  isrc: z.string().nullish(),
  permalink: z.string().nullish(),
  is_streamable: z.boolean().nullish(),
  is_stream_gated: z.boolean().nullish(),
  access: z.object({ stream: z.boolean().nullish() }).nullish(),
  preview: z.unknown().optional(),
  preview_cid: z.string().nullish(),
  allowed_api_keys: z.array(z.string()).nullish(),
  is_available: z.boolean().nullish(),
  is_delete: z.boolean().nullish(),
  artwork: z
    .object({
      '150x150': z.string().nullish(),
      '480x480': z.string().nullish(),
      '1000x1000': z.string().nullish(),
    })
    .nullish(),
  user: AudiusUser,
});
export type AudiusTrack = z.infer<typeof AudiusTrack>;

const ListResponse = z.object({ data: lenientArray(AudiusTrack) });
const ItemResponse = z.object({ data: AudiusTrack.nullish().catch(null) });

/**
 * Статус по правилам digest: full — только если трек стримится, доступен, не за «воротами»
 * и не ограничен чужими API-ключами. Иначе preview при наличии отрывка.
 * Удалённый или снятый трек не отдаём даже отрывком — digest этот случай не разбирает.
 */
export function audiusPlayback(t: AudiusTrack, apiKey: string | undefined): Playback {
  if (t.is_delete === true || t.is_available !== true) return 'unavailable';
  const keys = t.allowed_api_keys;
  const keyAllowed = keys == null || (apiKey !== undefined && keys.some((k) => k.toLowerCase() === apiKey.toLowerCase()));
  if (t.is_streamable === true && t.access?.stream === true && t.is_stream_gated !== true && keyAllowed) return 'full';
  const hasPreview = (t.preview !== null && t.preview !== undefined && t.preview !== '') || !!t.preview_cid;
  return hasPreview ? 'preview' : 'unavailable';
}

/**
 * Вероятно чужая загрузка. Проверенные авторы проходят. Непроверенные — только если в названии нет
 * «Артист - Название» с другим артистом (иначе это перезалив, как «Кино - Кукушка» от случайного аккаунта).
 */
export function isLikelyPirated(t: AudiusTrack, blocklist: ReadonlySet<string> = CATALOG_BLOCKLIST): boolean {
  const handle = t.user.handle?.toLowerCase();
  if ((handle && blocklist.has(`user:${handle}`)) || blocklist.has(`audius:${t.id}`)) return true;
  if (t.user.is_verified === true) return false;
  const split = splitArtistTitle(t.title);
  if (!split) return false;
  const uploader = [t.user.name, t.user.handle].filter((v): v is string => !!v && v.trim() !== '');
  // Порядок бывает и «Название - Автор»: у самих авторов это частый формат.
  const right = parseTitle(split.title).base;
  return !uploader.some((u) => sameArtist(split.artist, u) || sameArtist(right, u));
}

export interface AudiusProviderOptions {
  http: HttpClient;
  appName: string;
  apiKey?: string | undefined;
  blocklist?: ReadonlySet<string>;
}

export class AudiusProvider implements CatalogProvider, UndergroundCapable {
  readonly id = 'audius' as const;
  readonly enabled = true;
  private readonly http: HttpClient;
  private readonly appName: string;
  private readonly apiKey: string | undefined;
  private readonly blocklist: ReadonlySet<string>;

  constructor(opts: AudiusProviderOptions) {
    this.http = opts.http;
    this.appName = opts.appName;
    this.apiKey = opts.apiKey;
    this.blocklist = opts.blocklist ?? CATALOG_BLOCKLIST;
  }

  /** app_name — всегда, api_key — если настроен (повышает лимиты и открывает треки с allowed_api_keys). */
  private appParams(): [string, string][] {
    return this.apiKey ? [['app_name', this.appName], ['api_key', this.apiKey]] : [['app_name', this.appName]];
  }

  private url(path: string, params: [string, string][]): string {
    return `${AUDIUS_API}${path}?${new URLSearchParams([...params, ...this.appParams()])}`;
  }

  /** Стабильная ссылка API (302 на узел), а не подписанный URL узла: тот протухает. */
  streamUrl(id: string, preview: boolean): string {
    const params: [string, string][] = [...this.appParams()];
    if (preview) params.push(['preview', 'true']);
    return `${AUDIUS_API}/tracks/${encodeURIComponent(id)}/stream?${new URLSearchParams(params)}`;
  }

  private audiusGenres(query: ProviderQuery): string[] {
    return uniq((query.genres ?? []).flatMap((g) => GENRE_VOCABULARY[g].audius));
  }

  toTrack(t: AudiusTrack): Track | null {
    if (isLikelyPirated(t, this.blocklist)) return null;
    if (t.genre && AUDIUS_NON_MUSIC_GENRES.has(t.genre)) return null;
    const durationSec = Math.max(0, t.duration ?? 0);
    if (!durationOk(durationSec)) return null;
    const playback = audiusPlayback(t, this.apiKey);
    if (playback === 'unavailable') return null;

    const artist = t.user.name?.trim() || t.user.handle?.trim() || 'Audius';
    let title = t.title.trim();
    const split = splitArtistTitle(title);
    if (split && sameArtist(split.artist, artist)) title = split.title;

    const art = t.artwork;
    const track: Track = {
      id: `audius:${t.id}`,
      provider: 'audius',
      title,
      artist,
      album: null,
      artworkUrl: art?.['480x480'] ?? art?.['1000x1000'] ?? art?.['150x150'] ?? null,
      durationSec,
      playback,
      previewSec: playback === 'preview' ? AUDIUS_PREVIEW_SEC : null,
      genres: t.genre ? [t.genre] : [],
      isrc: t.isrc?.trim() || null,
      licenseUrl: OML_URL,
      streamUrl: this.streamUrl(t.id, playback === 'preview'),
      pageUrl: t.permalink ? `https://audius.co${t.permalink.startsWith('/') ? '' : '/'}${t.permalink}` : null,
    };
    return t.user.is_verified === true ? markVerified(track) : track;
  }

  private toTracks(items: readonly AudiusTrack[], query: ProviderQuery): Track[] {
    return items
      .map((t) => this.toTrack(t))
      .filter((t): t is Track => t !== null && matchesLanguage(t, query.language))
      .slice(0, query.limit);
  }

  private async list(path: string, params: [string, string][], signal: AbortSignal) {
    const res = await this.http.getJson(this.url(path, params), ListResponse, signal);
    return res.data;
  }

  async search(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    const params: [string, string][] = [];
    if (query.text) params.push(['query', query.text]);
    for (const g of this.audiusGenres(query)) params.push(['genre', g]);
    const moods = query.moods ?? [];
    for (const m of uniq(moods.flatMap((id) => MOOD_VOCABULARY[id].audius.moods))) params.push(['mood', m]);
    const [onlyMood] = moods;
    if (moods.length === 1 && onlyMood) {
      const vocab = MOOD_VOCABULARY[onlyMood].audius;
      if (vocab.bpmMin !== undefined) params.push(['bpm_min', String(vocab.bpmMin)]);
      if (vocab.bpmMax !== undefined) params.push(['bpm_max', String(vocab.bpmMax)]);
    }
    params.push(['sort_method', query.sort ?? 'relevant']);
    params.push(['limit', String(fetchLimit(query, 50))]);
    if (query.offset) params.push(['offset', String(query.offset)]);
    return this.toTracks(await this.list('/tracks/search', params, signal), query);
  }

  /** Тренды и новинки принимают один жанр: по нескольким жанрам — до трёх запросов вперемешку. */
  private async byGenres(path: string, extra: [string, string][], query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    const genres = this.audiusGenres(query).slice(0, 3);
    const perCall = genres.length > 1 ? Math.ceil(fetchLimit(query, 50) / genres.length) : fetchLimit(query, 50);
    const calls = (genres.length > 0 ? genres : [null]).map((genre) => {
      const params: [string, string][] = [...extra, ['limit', String(perCall)]];
      if (genre) params.push(['genre', genre]);
      if (query.offset) params.push(['offset', String(query.offset)]);
      return this.list(path, params, signal);
    });
    const settled = await Promise.allSettled(calls);
    const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
    return this.toTracks(interleave(ok), query);
  }

  trending(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    return this.byGenres('/tracks/trending', [['time', 'week']], query, signal);
  }

  async underground(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    const params: [string, string][] = [['limit', String(fetchLimit(query, 50))]];
    if (query.offset) params.push(['offset', String(query.offset)]);
    return this.toTracks(await this.list('/tracks/trending/underground', params, signal), query);
  }

  async latest(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    try {
      return await this.byGenres('/tracks/latest', [], query, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      // /tracks/latest нестабилен и не описан в документации — лучше тренды, чем пустой раздел.
      return this.trending(query, signal);
    }
  }

  async resolve(externalId: string, signal: AbortSignal): Promise<Track | null> {
    if (!/^[A-Za-z0-9]{1,32}$/.test(externalId)) return null;
    try {
      const res = await this.http.getJson(this.url(`/tracks/${externalId}`, []), ItemResponse, signal);
      return res.data ? this.toTrack(res.data) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
