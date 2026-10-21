import {
  MOODS,
  type ArtistSuggestion,
  type GenreId,
  type ProviderId,
  type Section,
  type SectionId,
  type Taste,
  type Track,
} from '@muzradar/shared';
import { artistSuggestions } from './artists.ts';
import { CACHE_TTL, TtlCache } from './cache.ts';
import { dedupKey, interleave, isVerified, matchesLanguage, mergeTracks, normalizeText, sameArtist, sourceRank } from './normalize.ts';
import { hasUnderground } from './providers/common.ts';
import { SIMILAR_DISABLED, type SimilarArtistsSource } from './similar.ts';
import type { CatalogProvider, ProviderQuery } from './types.ts';

/**
 * Жёсткий потолок на всю витрину. Холодный GET должен уложиться в 7 с — остаток уходит на БД, авторизацию
 * и сериализацию. Обычно витрина готова раньше: каждый источник ограничен ещё и SOURCE_TIMEOUT_MS.
 */
export const SECTIONS_BUDGET_MS = 6_000;
/** Один вызов источника в витрине: не успел — выпадает из своего раздела, а не держит всю витрину до потолка. */
export const SOURCE_TIMEOUT_MS = 4_500;
export const SEARCH_BUDGET_MS = 5_000;
export const RESOLVE_BUDGET_MS = 5_000;
/** Треков в разделе витрины. */
export const SECTION_SIZE = 20;
/** Артистов профиля, которых ищем для «Для вас»: у Audius 10 запросов в секунду на всю витрину, а артистов в профиле до 30. */
export const FOR_YOU_ARTISTS_MAX = 5;
/** Сколько артистов профиля отдаём в ListenBrainz и сколько похожих подмешиваем. */
export const SIMILAR_SEEDS = 2;
export const SIMILAR_MAX = 4;
/** Сколько витрина ждёт похожих артистов; не дождалась — они догрузятся в кэш к следующей сборке. */
export const SIMILAR_WAIT_MS = 1_500;
/**
 * IA в витрине — только в «На русском», где его некем заменить, и не больше пяти альбомов:
 * метаданные каждого — отдельный запрос при лимите 2 одновременных на archive.org.
 */
export const ARCHIVE_RUSSIAN_LIMIT = 15;
/**
 * Поиск Audius без текста отдаёт мировой топ, где кириллицы нет. Частые русские слова дают по 40–50
 * кириллических треков на запрос, но проверенных авторов среди них на замере 2026-09-23 не было ни одного.
 */
export const AUDIUS_RUSSIAN_TERMS = ['ты', 'мы'] as const;

export const RUSSIAN_NOTICE = 'Источник временно недоступен — русский каталог появится, когда подключим источник';

const PROVIDER_NAMES: Partial<Record<ProviderId, string>> = {
  audius: 'Audius',
  jamendo: 'Jamendo',
  archive: 'Internet Archive',
  commons: 'Wikimedia Commons',
};

type ProviderCall = 'search' | 'trending' | 'latest' | 'underground';

interface SectionSource {
  provider: ProviderId;
  call: ProviderCall;
  /** Поправки к запросу раздела только для этого источника. */
  query?: Partial<ProviderQuery>;
  /** Отбор поверх фильтров самого провайдера. */
  accept?: (track: Track) => boolean;
  /** Треки с одним ключом идут группой, группы перемешиваются: один артист не забирает весь раздел. */
  group?: string;
}

interface SectionSpec {
  id: Exclude<SectionId, 'nearby'>;
  title: string;
  subtitle: string | null;
  /** Ступени по убыванию приоритета: опрашиваются параллельно, но следующая только добирает до SECTION_SIZE. */
  tiers: readonly (readonly SectionSource[])[];
  query: ProviderQuery;
  /** Артисты профиля («Для вас»): от них ищутся похожие, которые встают сразу за первой ступенью. */
  artists?: readonly string[];
  /** Раздел не прячется пустым — вместо треков честная пометка. */
  keepEmpty?: boolean;
}

function query(partial: Partial<ProviderQuery>): ProviderQuery {
  return { limit: SECTION_SIZE, ...partial };
}

/** Артисты профиля без повторов («Кино» и «Kino» — один), в порядке выбора, не больше FOR_YOU_ARTISTS_MAX. */
export function tasteArtists(taste: Taste): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of taste.artists) {
    const name = raw.trim();
    const key = normalizeText(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, FOR_YOU_ARTISTS_MAX);
}

/** У Audius имя может взять себе кто угодно: совпадение по имени засчитываем только проверенному автору. */
function artistMatch(name: string) {
  return (track: Track) => sameArtist(track.artist, name) && (track.provider !== 'audius' || isVerified(track));
}

/**
 * Где ищем артистов и скольких (по порядку профиля). IA нет: поиск там — это ещё до шести запросов метаданных
 * на каждого артиста. Jamendo — не больше двух: 2 запроса в секунду и 35 000 в месяц на всё приложение.
 */
const ARTIST_LOOKUP: Partial<Record<ProviderId, number>> = { audius: FOR_YOU_ARTISTS_MAX, jamendo: 2, commons: FOR_YOU_ARTISTS_MAX };
/** Похожих ищем скромнее: это добавка к артистам профиля. У Commons современных исполнителей почти нет. */
const SIMILAR_LOOKUP: Partial<Record<ProviderId, number>> = { audius: SIMILAR_MAX, jamendo: 1 };

function artistSources(names: readonly string[], lookup: Partial<Record<ProviderId, number>>): SectionSource[] {
  const providers = Object.entries(lookup) as [ProviderId, number][];
  return names.flatMap((name, index) =>
    providers
      .filter(([, max]) => index < max)
      .map(([provider]) => ({
        provider,
        call: 'search' as const,
        // Жанры и настроение раздела здесь только сузили бы выдачу: ищем самого артиста.
        query: { text: name, genres: [], moods: [], language: null, sort: 'relevant' as const },
        accept: artistMatch(name),
        group: normalizeText(name),
      })),
  );
}

/** Русские треки Audius — только проверенных авторов и только с кириллицей в названии или имени. */
function verifiedRussian(track: Track): boolean {
  return isVerified(track) && matchesLanguage(track, 'ru');
}

/**
 * Откуда берётся каждый раздел (таблица из digest music-sources).
 * «nearby» собирается из присутствия на карте, а не из каталога, — здесь его нет.
 */
export function sectionSpecs(taste: Taste): SectionSpec[] {
  const genres = taste.genres.slice(0, 6);
  const mood = taste.moods[0];
  const artists = tasteArtists(taste);
  const specs: SectionSpec[] = [
    {
      id: 'for_you',
      title: 'Для вас',
      subtitle: 'Ваши артисты, жанры и настроение',
      tiers: [
        // 1 — артисты из профиля
        artistSources(artists, ARTIST_LOOKUP),
        // 2 — жанры и настроение профиля
        [
          { provider: 'audius', call: 'search' },
          { provider: 'jamendo', call: 'search' },
        ],
        // 3 — тренды тех же жанров: добирают раздел, если первым ступеням нечего дать
        [
          { provider: 'audius', call: 'trending', query: { moods: [] } },
          { provider: 'jamendo', call: 'trending', query: { moods: [] } },
        ],
      ],
      query: query({ genres, moods: mood ? [mood] : [], sort: 'popular' }),
      artists,
    },
    {
      id: 'new',
      title: 'Новое',
      subtitle: 'Свежие релизы',
      tiers: [
        [
          { provider: 'audius', call: 'latest' },
          { provider: 'jamendo', call: 'latest' },
        ],
      ],
      query: query({ genres: genres.slice(0, 3), sort: 'recent' }),
    },
    {
      id: 'popular',
      title: 'Популярное',
      subtitle: 'Что слушают на этой неделе',
      tiers: [
        [
          { provider: 'audius', call: 'trending' },
          { provider: 'jamendo', call: 'trending' },
        ],
      ],
      query: query({ sort: 'popular' }),
    },
    {
      id: 'classics',
      title: 'Классика',
      subtitle: 'Общественное достояние и свободные лицензии',
      tiers: [
        [
          { provider: 'commons', call: 'search' },
          { provider: 'jamendo', call: 'search' },
        ],
      ],
      query: query({ genres: ['classical'], sort: 'popular' }),
    },
    {
      id: 'russian',
      title: 'На русском',
      subtitle: 'Русскоязычные исполнители',
      // Jamendo (lang=ru) — если настроен; Audius и IA — всегда, чтобы раздел не зависел от одного ключа.
      // Commons сюда не берём: по-русски там произношения слов, чтение стихов и даже запрещённые гимны.
      tiers: [
        [
          { provider: 'jamendo', call: 'search' },
          ...AUDIUS_RUSSIAN_TERMS.map((text) => ({
            provider: 'audius' as const,
            call: 'search' as const,
            query: { text },
            accept: verifiedRussian,
          })),
          { provider: 'archive', call: 'search', query: { limit: ARCHIVE_RUSSIAN_LIMIT } },
        ],
      ],
      query: query({ language: 'ru', sort: 'popular' }),
      keepEmpty: true,
    },
    {
      id: 'foreign',
      title: 'Зарубежное',
      subtitle: 'Без русскоязычных исполнителей',
      tiers: [
        [
          { provider: 'audius', call: 'trending' },
          { provider: 'jamendo', call: 'trending' },
        ],
      ],
      query: query({ language: 'foreign', sort: 'popular' }),
    },
    {
      id: 'underground',
      title: 'Андеграунд',
      subtitle: 'Малоизвестное, но живое',
      tiers: [[{ provider: 'audius', call: 'underground' }]],
      query: query({ sort: 'popular' }),
    },
  ];

  if (mood) {
    const label = MOODS.find((m) => m.id === mood)?.label ?? mood;
    specs.push({
      id: 'moods',
      title: label,
      subtitle: 'Под настроение',
      tiers: [
        [
          { provider: 'audius', call: 'search' },
          { provider: 'jamendo', call: 'search' },
        ],
      ],
      query: query({ moods: [mood], sort: 'popular' }),
    });
  }
  return specs;
}

/** Ключ кэша витрины: разделы зависят только от вкуса (жанры, настроение, артисты), а не от пользователя. */
export function tasteKey(taste: Taste): string {
  const genres = [...taste.genres].sort().join(',');
  const mood = taste.moods[0] ?? '';
  const artists = tasteArtists(taste).map(normalizeText).join(',');
  return `${genres}|${mood}|${artists}`;
}

/** Обещание, которое обязательно завершится к дедлайну, даже если источник «завис». */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function callProvider(provider: CatalogProvider, call: ProviderCall, q: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
  if (call === 'underground') {
    return hasUnderground(provider) ? provider.underground(q, signal) : provider.trending(q, signal);
  }
  return provider[call](q, signal);
}

interface SourceResult {
  source: SectionSource;
  tracks: Track[];
  /** false — источник упал или не успел к своему таймауту. */
  ok: boolean;
}

/** Треки ступени: без групп — по порядку источников, с группами — поочерёдно из каждой группы. */
function tierTracks(results: readonly SourceResult[]): Track[] {
  const groups = new Map<string, Track[]>();
  for (const { source, tracks } of results) {
    const key = source.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), ...tracks]);
  }
  return interleave([...groups.values()]);
}

interface BuiltSection {
  section: Section;
  /** Какой-то источник не ответил — такую витрину кэшируем ненадолго. */
  partial: boolean;
}

interface BuiltSections {
  sections: Section[];
  partial: boolean;
}

/** Насколько трек отвечает запросу: сначала совпадение, потом качество источника. */
export function relevance(track: Track, needle: string): number {
  if (!needle) return 0;
  const title = normalizeText(track.title);
  const artist = normalizeText(track.artist);
  let score = 0;
  if (title === needle) score += 100;
  else if (title.startsWith(needle)) score += 60;
  else if (title.includes(needle)) score += 30;
  if (artist === needle) score += 80;
  else if (artist.startsWith(needle)) score += 40;
  else if (artist.includes(needle)) score += 20;
  const words = needle.split(' ').filter((w) => w !== '');
  if (words.length > 1 && words.every((w) => title.includes(w) || artist.includes(w))) score += 15;
  return score;
}

export interface CatalogServiceOptions {
  providers: readonly CatalogProvider[];
  now?: () => number;
  sectionsBudgetMs?: number;
  sourceTimeoutMs?: number;
  searchBudgetMs?: number;
  /** Похожие артисты для «Для вас»; по умолчанию выключено и в сеть не ходит. */
  similar?: SimilarArtistsSource;
  similarWaitMs?: number;
}

/**
 * Витрина и поиск поверх нескольких источников: каждый источник опрашивается отдельно,
 * упавший или не успевший — просто выпадает из выдачи (`Promise.allSettled` + дедлайн).
 */
export class CatalogService {
  private readonly providers: Map<ProviderId, CatalogProvider>;
  private readonly sectionsBudgetMs: number;
  private readonly sourceTimeoutMs: number;
  private readonly searchBudgetMs: number;
  private readonly similar: SimilarArtistsSource;
  private readonly similarWaitMs: number;
  private readonly sectionsCache: TtlCache<BuiltSections>;
  private readonly searchCache: TtlCache<Track[]>;
  private readonly resolveCache: TtlCache<Track | null>;

  constructor(opts: CatalogServiceOptions) {
    this.providers = new Map(opts.providers.filter((p) => p.enabled).map((p) => [p.id, p]));
    this.sectionsBudgetMs = opts.sectionsBudgetMs ?? SECTIONS_BUDGET_MS;
    this.sourceTimeoutMs = opts.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS;
    this.searchBudgetMs = opts.searchBudgetMs ?? SEARCH_BUDGET_MS;
    this.similar = opts.similar ?? SIMILAR_DISABLED;
    this.similarWaitMs = opts.similarWaitMs ?? SIMILAR_WAIT_MS;
    const clock = opts.now ? { now: opts.now } : {};
    this.sectionsCache = new TtlCache({ max: 200, ...clock });
    this.searchCache = new TtlCache({ max: 500, ...clock });
    this.resolveCache = new TtlCache({ max: 2_000, ...clock });
  }

  /** Источники, которые реально настроены (у Jamendo без client_id `enabled = false`). */
  get providerIds(): ProviderId[] {
    return [...this.providers.keys()];
  }

  private async gather(sources: readonly SectionSource[], q: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    const calls = sources.flatMap((source) => {
      const provider = this.providers.get(source.provider);
      return provider ? [withDeadline(callProvider(provider, source.call, q, signal), signal)] : [];
    });
    const settled = await Promise.allSettled(calls);
    return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }

  /** Источники раздела, каждый со своим таймаутом: зависший выпадает сам, остальные его не ждут. */
  private collect(sources: readonly SectionSource[], base: ProviderQuery, signal: AbortSignal): Promise<SourceResult[]> {
    const active = sources.flatMap((source) => {
      const provider = this.providers.get(source.provider);
      return provider ? [{ source, provider }] : [];
    });
    return Promise.all(
      active.map(async ({ source, provider }): Promise<SourceResult> => {
        const own = AbortSignal.any([signal, AbortSignal.timeout(this.sourceTimeoutMs)]);
        try {
          const tracks = await withDeadline(callProvider(provider, source.call, { ...base, ...source.query }, own), own);
          return { source, tracks: source.accept ? tracks.filter(source.accept) : tracks, ok: true };
        } catch {
          return { source, tracks: [], ok: false };
        }
      }),
    );
  }

  /**
   * Ступень 1.5 «Для вас»: треки похожих артистов. Вся ступень укладывается в таймаут одного источника,
   * ожидание самих похожих — ещё и в SIMILAR_WAIT_MS. Выключенный источник не вызывается вовсе.
   */
  private async similarTracks(spec: SectionSpec, signal: AbortSignal): Promise<{ tracks: Track[]; pending: boolean }> {
    const artists = spec.artists ?? [];
    if (!this.similar.enabled || artists.length === 0) return { tracks: [], pending: false };
    const stage = AbortSignal.any([signal, AbortSignal.timeout(this.sourceTimeoutMs)]);
    const wait = AbortSignal.any([stage, AbortSignal.timeout(this.similarWaitMs)]);
    const settled = await Promise.allSettled(
      artists.slice(0, SIMILAR_SEEDS).map((name) => withDeadline(this.similar.similar(name), wait)),
    );
    const pending = settled.some((r) => r.status === 'rejected');
    const seen = new Set(artists.map(normalizeText));
    const names: string[] = [];
    for (const name of settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))) {
      const key = normalizeText(name);
      if (!key || seen.has(key) || artists.some((a) => sameArtist(a, name))) continue;
      seen.add(key);
      names.push(name);
    }
    if (names.length === 0) return { tracks: [], pending };
    const results = await this.collect(artistSources(names.slice(0, SIMILAR_MAX), SIMILAR_LOOKUP), spec.query, stage);
    return { tracks: tierTracks(results), pending: pending || results.some((r) => !r.ok) };
  }

  /** Честная причина пустого «На русском»: что не подключено и кто не ответил. */
  private russianNotice(failed: readonly ProviderId[]): string {
    const reasons: string[] = [];
    if (!this.providers.has('jamendo')) reasons.push('Jamendo не подключён');
    if (failed.length > 0) {
      const names = failed.map((id) => PROVIDER_NAMES[id] ?? id);
      reasons.push(`${names.join(' и ')} ${names.length > 1 ? 'не ответили' : 'не ответил'}`);
    }
    return reasons.length > 0 ? `${RUSSIAN_NOTICE}. ${reasons.join(', ')}.` : `${RUSSIAN_NOTICE}.`;
  }

  private async buildSection(spec: SectionSpec, signal: AbortSignal): Promise<BuiltSection> {
    const [tiers, similar] = await Promise.all([
      Promise.all(spec.tiers.map((tier) => this.collect(tier, spec.query, signal))),
      this.similarTracks(spec, signal),
    ]);
    const [first = [], ...rest] = tiers.map(tierTracks);
    const tracks = mergeTracks([...first, ...similar.tracks, ...rest.flat()])
      .filter((t) => t.playback !== 'unavailable')
      .slice(0, SECTION_SIZE);
    const failed = [...new Set(tiers.flat().filter((r) => !r.ok).map((r) => r.source.provider))];
    const notice = spec.keepEmpty && tracks.length === 0 ? this.russianNotice(failed) : null;
    return {
      section: { id: spec.id, title: spec.title, subtitle: spec.subtitle, tracks, notice },
      partial: failed.length > 0 || similar.pending,
    };
  }

  private async buildSections(taste: Taste): Promise<BuiltSections> {
    const signal = AbortSignal.timeout(this.sectionsBudgetMs);
    const specs = sectionSpecs(taste);
    // «На русском» стартует первым: у archive.org и Jamendo лимиты на хост, и очередь запросов
    // других разделов не должна съесть его время. Порядок в ответе — прежний.
    const order = [...specs].sort((a, b) => Number(b.id === 'russian') - Number(a.id === 'russian'));
    const built = new Map<SectionId, BuiltSection>();
    await Promise.all(order.map(async (spec) => built.set(spec.id, await this.buildSection(spec, signal))));
    const all = specs.flatMap((spec) => built.get(spec.id) ?? []);
    return {
      // Пустой раздел выглядит поломкой — его не показываем. Кроме «На русском»: он остаётся с пометкой.
      sections: all.map((b) => b.section).filter((s) => s.tracks.length > 0 || !!s.notice),
      partial: all.some((b) => b.partial),
    };
  }

  async sections(taste: Taste): Promise<Section[]> {
    const built = await this.sectionsCache.wrap(
      tasteKey(taste),
      (value) => (value.partial ? CACHE_TTL.sectionsPartialMs : CACHE_TTL.sectionsMs),
      () => this.buildSections(taste),
    );
    return built.sections;
  }

  async search(text: string, limit: number): Promise<Track[]> {
    const q = text.trim();
    if (!q) return [];
    return this.searchCache.wrap(`${normalizeText(q)}|${limit}`, CACHE_TTL.searchMs, async () => {
      const signal = AbortSignal.timeout(this.searchBudgetMs);
      const sources = this.providerIds.map((provider) => ({ provider, call: 'search' as const }));
      const raw = await this.gather(sources, { text: q, limit, sort: 'relevant' }, signal);
      const needle = normalizeText(q);
      const merged = mergeTracks(raw).filter((t) => t.playback !== 'unavailable');
      return merged
        .map((track, index) => ({ track, index, score: relevance(track, needle) }))
        .sort((a, b) => b.score - a.score || sourceRank(a.track) - sourceRank(b.track) || a.index - b.index)
        .slice(0, limit)
        .map((x) => x.track);
    });
  }

  /** Свежая ссылка на поток по идентификатору `провайдер:внешний_id`. */
  async resolve(trackId: string): Promise<Track | null> {
    const at = trackId.indexOf(':');
    if (at <= 0) return null;
    const provider = this.providers.get(trackId.slice(0, at) as ProviderId);
    const externalId = trackId.slice(at + 1);
    if (!provider || !externalId) return null;
    return this.resolveCache.wrap(
      trackId,
      (value) => (value ? CACHE_TTL.resolveMs : CACHE_TTL.resolveMissMs),
      async () => {
        const signal = AbortSignal.timeout(RESOLVE_BUDGET_MS);
        const track = await withDeadline(provider.resolve(externalId, signal), signal);
        return track && track.playback !== 'unavailable' ? track : null;
      },
    );
  }

  artists(genres: readonly GenreId[]): ArtistSuggestion[] {
    return artistSuggestions(genres);
  }

  /** Совпадающие треки из разных источников — один; порядок сохраняется. */
  static dedup(tracks: readonly Track[]): Track[] {
    return mergeTracks(tracks);
  }

  static key(track: Track): string {
    return dedupKey(track);
  }
}
