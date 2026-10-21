import type { ProviderId, Section, Taste, Track } from '@muzradar/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { markVerified } from '../src/modules/catalog/normalize.ts';
import {
  ARCHIVE_RUSSIAN_LIMIT,
  AUDIUS_RUSSIAN_TERMS,
  CatalogService,
  FOR_YOU_ARTISTS_MAX,
  RUSSIAN_NOTICE,
  SIMILAR_SEEDS,
  sectionSpecs,
  tasteKey,
} from '../src/modules/catalog/service.ts';
import { buildSimilarArtists, LB_LABS_API, ListenBrainzSimilar, MB_API, type SimilarArtistsSource } from '../src/modules/catalog/similar.ts';
import type { CatalogProvider, ProviderQuery } from '../src/modules/catalog/types.ts';
import { hang, testHttp } from './fixtures/catalog/harness.ts';

const taste: Taste = { genres: ['rock', 'indie', 'ambient'], moods: ['night'], artists: ['Кино'] };

function track(id: string, provider: ProviderId, over: Partial<Track> = {}): Track {
  return {
    id,
    provider,
    title: `Трек ${id}`,
    artist: `Артист ${id}`,
    album: null,
    artworkUrl: null,
    durationSec: 200,
    playback: 'full',
    previewSec: null,
    genres: [],
    isrc: null,
    licenseUrl: null,
    streamUrl: `https://example.com/${id}.mp3`,
    pageUrl: null,
    ...over,
  };
}

type Call = 'search' | 'trending' | 'latest';

interface FakeOptions {
  id: ProviderId;
  tracks?: Track[];
  /** Ответ в зависимости от запроса; перекрывает `tracks`. */
  respond?: (call: Call, q: ProviderQuery) => Track[];
  enabled?: boolean;
  /** Бросает на каждом обращении. */
  fails?: boolean;
  /** Никогда не отвечает сам — только по сигналу отмены. */
  hangs?: boolean;
  resolved?: Track | null;
}

class FakeProvider implements CatalogProvider {
  readonly id: ProviderId;
  readonly enabled: boolean;
  calls = 0;
  readonly queries: Array<{ call: Call; q: ProviderQuery }> = [];
  private readonly opts: FakeOptions;

  constructor(opts: FakeOptions) {
    this.id = opts.id;
    this.enabled = opts.enabled ?? true;
    this.opts = opts;
  }

  private answer(call: Call, q: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    this.calls++;
    this.queries.push({ call, q });
    if (this.opts.fails) return Promise.reject(new Error(`${this.id} упал`));
    if (this.opts.hangs) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return Promise.resolve(this.opts.respond ? this.opts.respond(call, q) : (this.opts.tracks ?? []));
  }

  search(q: ProviderQuery, signal: AbortSignal) {
    return this.answer('search', q, signal);
  }
  trending(q: ProviderQuery, signal: AbortSignal) {
    return this.answer('trending', q, signal);
  }
  latest(q: ProviderQuery, signal: AbortSignal) {
    return this.answer('latest', q, signal);
  }
  async resolve(): Promise<Track | null> {
    this.calls++;
    if (this.opts.fails) throw new Error(`${this.id} упал`);
    return this.opts.resolved ?? null;
  }
}

describe('разделы витрины', () => {
  it('раздела «рядом» в каталоге нет — он собирается из присутствия', () => {
    expect(sectionSpecs(taste).map((s) => s.id)).not.toContain('nearby');
  });

  it('раздел настроения строится по первому настроению профиля', () => {
    const specs = sectionSpecs(taste);
    const moods = specs.find((s) => s.id === 'moods');
    expect(moods?.title).toBe('Ночь');
    expect(moods?.query.moods).toEqual(['night']);
    expect(sectionSpecs({ ...taste, moods: [] }).some((s) => s.id === 'moods')).toBe(false);
  });

  it('пустые разделы не показываются — кроме «На русском», который остаётся с пометкой', async () => {
    const service = new CatalogService({ providers: [new FakeProvider({ id: 'audius', tracks: [] })] });
    const sections = await service.sections(taste);
    expect(sections.map((s) => s.id)).toEqual(['russian']);
    expect(sections[0]?.tracks).toEqual([]);
    expect(sections[0]?.notice).toContain(RUSSIAN_NOTICE);
  });

  it('витрина собирается из того, что ответило: упавший и зависший источники выпадают', async () => {
    const good = new FakeProvider({ id: 'audius', tracks: [track('audius:1', 'audius'), track('audius:2', 'audius')] });
    const broken = new FakeProvider({ id: 'jamendo', fails: true });
    const frozen = new FakeProvider({ id: 'archive', hangs: true });
    const service = new CatalogService({
      providers: [good, broken, frozen],
      sectionsBudgetMs: 150,
    });

    const started = Date.now();
    const sections = await service.sections(taste);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.tracks.length > 0 || !!s.notice)).toBe(true);
    expect(sections.flatMap((s) => s.tracks).every((t) => t.provider === 'audius')).toBe(true);
    expect(broken.calls).toBeGreaterThan(0);
    expect(frozen.calls).toBeGreaterThan(0);
  });

  it('выключенный источник не опрашивается', async () => {
    const off = new FakeProvider({ id: 'jamendo', enabled: false, tracks: [track('jamendo:1', 'jamendo')] });
    const service = new CatalogService({ providers: [off, new FakeProvider({ id: 'audius', tracks: [track('audius:1', 'audius')] })] });
    await service.sections(taste);
    expect(off.calls).toBe(0);
  });

  it('вторая сборка того же вкуса берётся из кэша', async () => {
    const provider = new FakeProvider({ id: 'audius', tracks: [track('audius:1', 'audius')] });
    const service = new CatalogService({ providers: [provider] });
    await service.sections(taste);
    const first = provider.calls;
    await service.sections({ ...taste, genres: [...taste.genres].reverse() });
    expect(provider.calls).toBe(first);
  });
});

const byId = (sections: readonly Section[], id: Section['id']) => sections.find((s) => s.id === id);

describe('«На русском»', () => {
  it('все источники пусты или упали — раздел всё равно есть: без треков и с честной причиной', async () => {
    const audius = new FakeProvider({ id: 'audius', fails: true });
    const archive = new FakeProvider({ id: 'archive', fails: true });
    const jamendo = new FakeProvider({ id: 'jamendo', enabled: false });
    const service = new CatalogService({ providers: [audius, archive, jamendo] });

    const sections = await service.sections(taste);
    // остальные пустые разделы по-прежнему скрыты
    expect(sections.map((s) => s.id)).toEqual(['russian']);
    expect(sections[0]?.tracks).toEqual([]);
    expect(sections[0]?.notice).toBe(`${RUSSIAN_NOTICE}. Jamendo не подключён, Audius и Internet Archive не ответили.`);
    expect(jamendo.calls).toBe(0);
  });

  it('без Jamendo раздел собирают Audius (только проверенные авторы с кириллицей) и Internet Archive', async () => {
    const ruVerified = markVerified(track('audius:ru1', 'audius', { title: 'Ночной город', artist: 'Сияние' }));
    const ruUnverified = track('audius:ru2', 'audius', { title: 'Ночь', artist: 'Кто-то' });
    const latinVerified = markVerified(track('audius:en1', 'audius', { title: 'Night City', artist: 'Glow' }));
    const netlabel = track('archive:ru_netlabel/01.mp3', 'archive', { title: 'Railway To Nowhere', artist: 'Steam Flow' });
    const audius = new FakeProvider({
      id: 'audius',
      respond: (call, q) => (call === 'search' && q.language === 'ru' && q.text ? [ruVerified, ruUnverified, latinVerified] : []),
    });
    const archive = new FakeProvider({ id: 'archive', respond: (call, q) => (call === 'search' && q.language === 'ru' ? [netlabel] : []) });
    const jamendo = new FakeProvider({ id: 'jamendo', enabled: false, tracks: [track('jamendo:1', 'jamendo')] });
    const service = new CatalogService({ providers: [audius, archive, jamendo] });

    const russian = byId(await service.sections(taste), 'russian');
    expect(russian?.tracks.map((t) => t.id)).toEqual(['audius:ru1', 'archive:ru_netlabel/01.mp3']);
    expect(russian?.notice).toBeNull();
    expect(audius.queries.filter((x) => x.q.language === 'ru').map((x) => x.q.text)).toEqual([...AUDIUS_RUSSIAN_TERMS]);
    expect(archive.queries.find((x) => x.q.language === 'ru')?.q.limit).toBe(ARCHIVE_RUSSIAN_LIMIT);
    expect(jamendo.calls).toBe(0);
  });

  it('с Jamendo его треки lang=ru идут первыми', async () => {
    const jamendo = new FakeProvider({
      id: 'jamendo',
      respond: (call, q) => (call === 'search' && q.language === 'ru' ? [track('jamendo:7', 'jamendo', { title: 'Песня', artist: 'Автор' })] : []),
    });
    const archive = new FakeProvider({ id: 'archive', tracks: [track('archive:x/1.mp3', 'archive')] });
    const service = new CatalogService({ providers: [jamendo, archive] });
    expect(byId(await service.sections(taste), 'russian')?.tracks.map((t) => t.id)).toEqual(['jamendo:7', 'archive:x/1.mp3']);
  });
});

describe('«Для вас»', () => {
  const genreTrack = track('audius:genre', 'audius', { title: 'Жанр', artist: 'Жанровый' });
  const trendTrack = track('audius:trend', 'audius', { title: 'Тренд', artist: 'Трендовый' });
  const kino = markVerified(track('audius:kino', 'audius', { title: 'Звезда', artist: 'Kino' }));
  const fakeKino = track('audius:fake', 'audius', { title: 'Группа крови', artist: 'Кино' });
  const namesake = markVerified(track('audius:other', 'audius', { title: 'Кино', artist: 'Совсем другой' }));
  const disclosure = markVerified(track('audius:disc', 'audius', { title: 'Latch', artist: 'Disclosure' }));

  it('сначала артисты профиля (и «Kino» для «Кино»), потом жанры с настроением, потом тренды', async () => {
    const audius = new FakeProvider({
      id: 'audius',
      respond: (call, q) => {
        if (call === 'search' && q.text === 'Кино') return [fakeKino, namesake, kino];
        if (call === 'search' && q.text === 'Disclosure') return [disclosure];
        if (call === 'search' && !q.text && q.genres?.length) return [genreTrack];
        if (call === 'trending' && q.genres?.length) return [trendTrack];
        return [];
      },
    });
    const service = new CatalogService({ providers: [audius] });
    const forYou = byId(await service.sections({ ...taste, artists: ['Кино', 'Disclosure'] }), 'for_you');

    // непроверенный «Кино» с Audius — чужая загрузка, а трек «Кино» другого автора — не этот артист
    expect(forYou?.tracks.map((t) => t.id)).toEqual(['audius:kino', 'audius:disc', 'audius:genre', 'audius:trend']);
    const artistQuery = audius.queries.find((x) => x.q.text === 'Кино')?.q;
    expect(artistQuery?.genres).toEqual([]);
    expect(artistQuery?.moods).toEqual([]);
    expect(audius.queries.find((x) => x.call === 'search' && !x.q.text && x.q.genres?.length)?.q.moods).toEqual(['night']);
    expect(audius.queries.find((x) => x.call === 'trending' && x.q.genres?.length)?.q.moods).toEqual([]);
  });

  it('ищется не больше FOR_YOU_ARTISTS_MAX артистов, «Кино» и «kino» — один', async () => {
    const audius = new FakeProvider({ id: 'audius', tracks: [] });
    const artists = ['Кино', 'kino', 'Сплин', 'ДДТ', 'Би-2', 'Пикник', 'Алиса', 'Аквариум'];
    await new CatalogService({ providers: [audius] }).sections({ ...taste, artists });
    const searched = audius.queries.flatMap((x) => (x.q.text && artists.includes(x.q.text) ? [x.q.text] : []));
    expect(searched).toEqual(['Кино', 'Сплин', 'ДДТ', 'Би-2', 'Пикник']);
    expect(searched).toHaveLength(FOR_YOU_ARTISTS_MAX);
  });

  it('ключ кэша витрины учитывает артистов', async () => {
    expect(tasteKey({ ...taste, artists: ['Кино'] })).not.toBe(tasteKey({ ...taste, artists: ['Сплин'] }));
    expect(tasteKey({ ...taste, artists: ['Кино'] })).toBe(tasteKey({ ...taste, artists: [' кино '] }));

    const audius = new FakeProvider({ id: 'audius', tracks: [track('audius:1', 'audius')] });
    const service = new CatalogService({ providers: [audius] });
    await service.sections({ ...taste, artists: ['Кино'] });
    const first = audius.calls;
    await service.sections({ ...taste, artists: ['Сплин'] });
    expect(audius.calls).toBeGreaterThan(first);
  });
});

describe('ListenBrainz: похожие артисты', () => {
  const KINO = '064db6e8-fdfb-4acb-a327-fc2de75b37de';
  const SPLIN = '0783b768-6719-450b-a7e1-7e891da17af3';
  const mbBody = { artists: [{ id: KINO, name: 'Кино', score: 100, 'sort-name': 'Kino' }] };
  const lbBody = [
    { artist_mbid: KINO, name: 'Кино', score: 900 },
    { artist_mbid: SPLIN, name: 'Сплин', score: 738 },
  ];
  const genreTrack = track('audius:genre', 'audius', { title: 'Жанр', artist: 'Жанровый' });

  it('без флага в окружении выключено и не вызывается вовсе — даже с токеном', async () => {
    const off = buildSimilarArtists(loadConfig({ NODE_ENV: 'test' }));
    expect(off.enabled).toBe(false);
    expect(await off.similar('Кино')).toEqual([]);
    expect(buildSimilarArtists(loadConfig({ NODE_ENV: 'test', LISTENBRAINZ_TOKEN: 'token' })).enabled).toBe(false);
    expect(buildSimilarArtists(loadConfig({ NODE_ENV: 'test', LISTENBRAINZ_SIMILAR_ARTISTS: '1' })).enabled).toBe(true);

    let asked = 0;
    const spy: SimilarArtistsSource = {
      enabled: false,
      similar: () => {
        asked++;
        return Promise.resolve(['Сплин']);
      },
    };
    await new CatalogService({ providers: [new FakeProvider({ id: 'audius', tracks: [] })], similar: spy }).sections(taste);
    expect(asked).toBe(0);
  });

  it('включённый: похожие встают сразу за артистами профиля, ответ кэшируется', async () => {
    const { http, calls } = testHttp([
      { match: `${MB_API}/artist`, body: mbBody },
      { match: `${LB_LABS_API}/similar-artists/json`, body: lbBody },
    ]);
    const similar = new ListenBrainzSimilar({ http });
    const kino = markVerified(track('audius:kino', 'audius', { title: 'Звезда', artist: 'Кино' }));
    const splin = markVerified(track('audius:splin', 'audius', { title: 'Выхода нет', artist: 'Сплин' }));
    const audius = new FakeProvider({
      id: 'audius',
      respond: (call, q) => {
        if (call === 'search' && q.text === 'Кино') return [kino];
        if (call === 'search' && q.text === 'Сплин') return [splin];
        if (call === 'search' && !q.text && q.genres?.length) return [genreTrack];
        return [];
      },
    });
    const service = new CatalogService({ providers: [audius], similar });
    const forYou = byId(await service.sections({ ...taste, artists: ['Кино'] }), 'for_you');

    expect(forYou?.tracks.map((t) => t.id)).toEqual(['audius:kino', 'audius:splin', 'audius:genre']);
    expect(calls.filter((u) => u.startsWith(MB_API))).toHaveLength(1);
    expect(calls.filter((u) => u.startsWith(LB_LABS_API))).toHaveLength(1);
    expect(calls[0]).toContain(`query=${encodeURIComponent('artist:"Кино"')}`);
    expect(await similar.similar('кино')).toEqual(['Сплин']);
    expect(calls).toHaveLength(2);
  });

  it('MusicBrainz не уверен в артисте — ListenBrainz не спрашиваем', async () => {
    const { http, calls } = testHttp([
      { match: `${MB_API}/artist`, body: { artists: [{ id: KINO, name: 'Симфоническое Кино', score: 68 }] } },
      { match: LB_LABS_API, body: lbBody },
    ]);
    expect(await new ListenBrainzSimilar({ http }).similar('Кино')).toEqual([]);
    expect(calls.filter((u) => u.startsWith(LB_LABS_API))).toHaveLength(0);
  });

  it('зависший ListenBrainz не держит витрину, а в MusicBrainz уходит не больше SIMILAR_SEEDS имён', async () => {
    const { http, calls } = testHttp([
      { match: `${MB_API}/artist`, body: mbBody },
      { match: LB_LABS_API, handler: hang },
    ]);
    const similar = new ListenBrainzSimilar({ http, fetchTimeoutMs: 5_000 });
    const audius = new FakeProvider({ id: 'audius', respond: (call, q) => (call === 'search' && !q.text && q.genres?.length ? [genreTrack] : []) });
    const service = new CatalogService({ providers: [audius], similar, similarWaitMs: 100 });

    const started = Date.now();
    const sections = await service.sections({ ...taste, artists: ['Кино', 'Сплин', 'ДДТ', 'Би-2', 'Пикник'] });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(byId(sections, 'for_you')?.tracks.map((t) => t.id)).toEqual(['audius:genre']);
    expect(calls.filter((u) => u.startsWith(MB_API))).toHaveLength(SIMILAR_SEEDS);
  });
});

describe('таймауты и кэш витрины', () => {
  it('зависший источник выпадает по своему таймауту, не дожидаясь общего дедлайна', async () => {
    const good = new FakeProvider({ id: 'audius', tracks: [track('audius:1', 'audius')] });
    const frozen = new FakeProvider({ id: 'archive', hangs: true });
    const service = new CatalogService({ providers: [good, frozen], sectionsBudgetMs: 10_000, sourceTimeoutMs: 100 });

    const started = Date.now();
    const sections = await service.sections(taste);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(frozen.calls).toBeGreaterThan(0);
    expect(byId(sections, 'popular')?.tracks.map((t) => t.id)).toEqual(['audius:1']);
    expect(byId(sections, 'russian')?.notice).toContain('Internet Archive не ответил');
  });

  it('витрину, где кто-то не ответил, пересобираем через пару минут, полную держим дольше', async () => {
    let now = 1_000_000;
    const clock = () => now;
    const good = new FakeProvider({ id: 'audius', tracks: [track('audius:1', 'audius')] });
    const partial = new CatalogService({ providers: [good, new FakeProvider({ id: 'archive', fails: true })], now: clock });
    await partial.sections(taste);
    const before = good.calls;
    now += 3 * 60_000;
    await partial.sections(taste);
    expect(good.calls).toBeGreaterThan(before);

    const full = new FakeProvider({ id: 'audius', tracks: [track('audius:2', 'audius')] });
    const complete = new CatalogService({ providers: [full], now: clock });
    await complete.sections(taste);
    const once = full.calls;
    now += 3 * 60_000;
    await complete.sections(taste);
    expect(full.calls).toBe(once);
  });
});

describe('поиск', () => {
  const same = (id: string, provider: ProviderId, over: Partial<Track> = {}) =>
    track(id, provider, { title: 'Группа крови', artist: 'Кино', ...over });

  it('дубли из разных источников склеиваются, точное совпадение впереди', async () => {
    const audius = new FakeProvider({
      id: 'audius',
      // проверенный автор Audius обгоняет Jamendo — выигрывает его карточка трека
      tracks: [track('audius:9', 'audius', { title: 'Другое', artist: 'Кто-то' }), markVerified(same('audius:1', 'audius'))],
    });
    const jamendo = new FakeProvider({
      id: 'jamendo',
      tracks: [same('jamendo:1', 'jamendo', { title: 'Gruppa krovi (Remastered)', artist: 'Kino' })],
    });
    const service = new CatalogService({ providers: [audius, jamendo] });

    const tracks = await service.search('Группа крови', 10);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.title).toBe('Группа крови');
    expect(tracks.filter((t) => t.title.toLowerCase().includes('gruppa'))).toHaveLength(0);
  });

  it('недоступные треки в выдачу не попадают', async () => {
    const p = new FakeProvider({ id: 'audius', tracks: [track('audius:1', 'audius', { playback: 'unavailable', streamUrl: null })] });
    expect(await new CatalogService({ providers: [p] }).search('что угодно', 10)).toEqual([]);
  });

  it('пустой запрос не ходит в источники', async () => {
    const p = new FakeProvider({ id: 'audius', tracks: [] });
    expect(await new CatalogService({ providers: [p] }).search('   ', 10)).toEqual([]);
    expect(p.calls).toBe(0);
  });

  it('повторный запрос берётся из кэша', async () => {
    const p = new FakeProvider({ id: 'audius', tracks: [track('audius:1', 'audius')] });
    const service = new CatalogService({ providers: [p] });
    await service.search('кино', 10);
    await service.search('кино', 10);
    expect(p.calls).toBe(1);
  });
});

describe('resolve', () => {
  it('id разбирается по префиксу провайдера', async () => {
    const audius = new FakeProvider({ id: 'audius', resolved: track('audius:1', 'audius') });
    const archive = new FakeProvider({ id: 'archive', resolved: track('archive:item/file.mp3', 'archive') });
    const service = new CatalogService({ providers: [audius, archive] });

    expect((await service.resolve('audius:1'))?.id).toBe('audius:1');
    expect((await service.resolve('archive:item/file.mp3'))?.id).toBe('archive:item/file.mp3');
    expect(archive.calls).toBe(1);
    expect(await service.resolve('deezer:123')).toBeNull();
    expect(await service.resolve('нетпрефикса')).toBeNull();
  });

  it('недоступный трек — это null', async () => {
    const p = new FakeProvider({ id: 'audius', resolved: track('audius:1', 'audius', { playback: 'unavailable', streamUrl: null }) });
    expect(await new CatalogService({ providers: [p] }).resolve('audius:1')).toBeNull();
  });
});

describe('подсказки артистов', () => {
  it('имена перемешаны по жанрам, фотографий нет', () => {
    const service = new CatalogService({ providers: [] });
    const artists = service.artists(['russian_rock', 'kpop']);
    expect(artists.length).toBeGreaterThanOrEqual(16);
    expect(artists.every((a) => a.imageUrl === null)).toBe(true);
    expect(artists.map((a) => a.name)).toContain('Кино');
    expect(artists.map((a) => a.name)).toContain('BTS');
    // первые двое — из разных жанров
    expect(artists[0]?.genres[0]).not.toBe(artists[1]?.genres[0]);
  });

  it('без жанров подсказки берутся по всем', () => {
    const artists = new CatalogService({ providers: [] }).artists([]);
    expect(artists.length).toBeGreaterThan(20);
  });
});
