import { z } from 'zod';
import type { Config } from '../../config.ts';
import { CACHE_TTL, TtlCache } from './cache.ts';
import { HttpClient, lenientArray } from './http.ts';
import { normalizeText, sameArtist } from './normalize.ts';

export const MB_API = 'https://musicbrainz.org/ws/2';
export const LB_LABS_API = 'https://labs.api.listenbrainz.org';
/** Без точной строки алгоритма labs молча отвечает `[]` (digest music-sources). */
export const LB_SIMILAR_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
/** Похожих на одного артиста берём немного: это добавка к его собственным трекам, а не замена. */
export const SIMILAR_PER_ARTIST = 3;
/** Ниже — MusicBrainz уже угадывает («Кино» → «Симфоническое Кино» даёт 68). */
const MB_MIN_SCORE = 90;
/**
 * Холодный поиск MBID + похожих занял 1,7 с + 3,2 с (замер 2026-09-23) — дольше, чем витрина готова ждать.
 * Поэтому он идёт со своим таймаутом, не привязанным к запросу: не успел к витрине — ляжет в кэш к следующей сборке.
 */
export const SIMILAR_FETCH_TIMEOUT_MS = 15_000;

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MbArtistSearch = z.object({
  artists: lenientArray(
    z.object({
      id: z.string().regex(MBID),
      name: z.string(),
      score: z.coerce.number().catch(0),
      'sort-name': z.string().nullish(),
      aliases: lenientArray(z.object({ name: z.string() })).optional(),
    }),
  ),
});

const LbSimilarArtists = lenientArray(
  z.object({
    artist_mbid: z.string(),
    name: z.string().trim().min(1).max(80),
    score: z.coerce.number().catch(0),
  }),
);

/** Похожие артисты для «Для вас». Выключенный источник в сеть не ходит вообще. */
export interface SimilarArtistsSource {
  readonly enabled: boolean;
  /** Имена похожих; `[]` — не нашли. Отклоняется, только если источник не ответил. */
  similar(artist: string): Promise<string[]>;
}

export const SIMILAR_DISABLED: SimilarArtistsSource = { enabled: false, similar: () => Promise.resolve([]) };

/** Запрос MusicBrainz без синтаксиса Lucene: имя артиста не должно ломать поиск. */
function mbQuery(name: string): string {
  return `artist:"${name.replace(/["\\]/g, ' ').trim()}"`;
}

export interface ListenBrainzSimilarOptions {
  http: HttpClient;
  now?: () => number;
  fetchTimeoutMs?: number;
}

/** Имя → MBID (MusicBrainz) → похожие (ListenBrainz labs). Оба сервиса без токена. */
export class ListenBrainzSimilar implements SimilarArtistsSource {
  readonly enabled = true;
  private readonly http: HttpClient;
  private readonly cache: TtlCache<string[]>;
  private readonly fetchTimeoutMs: number;

  constructor(opts: ListenBrainzSimilarOptions) {
    this.http = opts.http;
    this.cache = new TtlCache({ max: 1_000, ...(opts.now ? { now: opts.now } : {}) });
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? SIMILAR_FETCH_TIMEOUT_MS;
  }

  similar(artist: string): Promise<string[]> {
    const key = normalizeText(artist);
    if (!key) return Promise.resolve([]);
    return this.cache.wrap(
      key,
      (names) => (names.length > 0 ? CACHE_TTL.similarArtistsMs : CACHE_TTL.similarArtistsMissMs),
      () => this.load(artist, AbortSignal.timeout(this.fetchTimeoutMs)),
    );
  }

  private async load(artist: string, signal: AbortSignal): Promise<string[]> {
    const sp = new URLSearchParams({ query: mbQuery(artist), fmt: 'json', limit: '5' });
    const found = await this.http.getJson(`${MB_API}/artist?${sp}`, MbArtistSearch, signal);
    const match = found.artists.find(
      (a) =>
        a.score >= MB_MIN_SCORE &&
        [a.name, a['sort-name'] ?? '', ...(a.aliases ?? []).map((x) => x.name)].some((n) => n && sameArtist(n, artist)),
    );
    if (!match) return [];
    const lp = new URLSearchParams({ artist_mbids: match.id, algorithm: LB_SIMILAR_ALGORITHM });
    const similar = await this.http.getJson(`${LB_LABS_API}/similar-artists/json?${lp}`, LbSimilarArtists, signal);
    return similar
      .filter((a) => a.artist_mbid !== match.id && !sameArtist(a.name, artist))
      .sort((a, b) => b.score - a.score)
      .slice(0, SIMILAR_PER_ARTIST)
      .map((a) => a.name);
  }
}

/**
 * Включается только флагом LISTENBRAINZ_SIMILAR_ARTISTS: имена из профиля уходят в MetaBrainz (США),
 * и это должно быть осознанным решением, а не побочным эффектом наличия токена.
 */
export function buildSimilarArtists(config: Config, now?: () => number): SimilarArtistsSource {
  if (!config.listenBrainzSimilarArtists) return SIMILAR_DISABLED;
  const http = new HttpClient({ userAgent: config.mbUserAgent });
  return new ListenBrainzSimilar({ http, ...(now ? { now } : {}) });
}
