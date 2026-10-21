import { ArtistSuggestionsResponse, SectionsResponse, Track, TracksResponse, type ProviderId } from '@muzradar/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../src/modules/catalog/providers/archive.ts';
import type { CatalogProvider, ProviderQuery } from '../src/modules/catalog/types.ts';
import { fixture, testHttp } from './fixtures/catalog/harness.ts';
import { authDevice, bearer, createTestContext, onboardUser, type TestContext } from './helpers.ts';

const ARCHIVE_ID = 'archive:ca015_va_cs/101.Etat_Des_Stocks_Klassikkos.mp3';

function fakeTrack(id: string, provider: ProviderId): Track {
  return {
    id,
    provider,
    title: 'Звезда по имени Солнце',
    artist: 'Кино',
    album: null,
    artworkUrl: null,
    durationSec: 224,
    playback: 'full',
    previewSec: null,
    genres: ['Rock'],
    isrc: null,
    licenseUrl: 'https://openaudiofoundation.org/open-music-license.pdf',
    streamUrl: `https://api.audius.co/v1/tracks/${id.split(':')[1]}/stream?app_name=MUZRADAR`,
    pageUrl: 'https://audius.co/kino/zvezda',
  };
}

/** Подменённый Audius: маршруты тестируются без сети. */
class FakeAudius implements CatalogProvider {
  readonly id = 'audius' as const;
  readonly enabled = true;
  private readonly tracks = [fakeTrack('audius:aaa111', 'audius')];

  search(_q: ProviderQuery) {
    return Promise.resolve(this.tracks);
  }
  trending(_q: ProviderQuery) {
    return Promise.resolve(this.tracks);
  }
  latest(_q: ProviderQuery) {
    return Promise.resolve(this.tracks);
  }
  underground(_q: ProviderQuery) {
    return Promise.resolve(this.tracks);
  }
  resolve(externalId: string) {
    return Promise.resolve(this.tracks.find((t) => t.id === `audius:${externalId}`) ?? null);
  }
}

describe('GET /v1/catalog', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    const { http } = testHttp([
      { match: 'advancedsearch.php', body: fixture('archive-search') },
      { match: '/metadata/ca015_va_cs', body: fixture('archive-metadata-ca015') },
      { match: '/metadata/', status: 404 },
    ]);
    ctx = await createTestContext({ catalogProviders: [new FakeAudius(), new ArchiveProvider({ http })] });
    token = (await onboardUser(ctx.app)).token;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('без токена — 401', async () => {
    for (const url of ['/v1/catalog/sections', '/v1/catalog/search?q=кино', `/v1/catalog/tracks/${ARCHIVE_ID}`]) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  it('до конца онбординга музыка закрыта — 403 onboarding_required', async () => {
    const device = await authDevice(ctx.app);
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog/sections', headers: bearer(device.accessToken) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'onboarding_required' });
  });

  it('подсказки артистов доступны во время онбординга', async () => {
    const device = await authDevice(ctx.app);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/catalog/artists?genres=russian_rock,kpop',
      headers: bearer(device.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = ArtistSuggestionsResponse.parse(res.json());
    expect(body.artists.map((a) => a.name)).toContain('Кино');
    expect(body.artists.every((a) => a.imageUrl === null)).toBe(true);
  });

  it('неизвестный жанр в подсказках — 400', async () => {
    const device = await authDevice(ctx.app);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/catalog/artists?genres=rock,шансон-2',
      headers: bearer(device.accessToken),
    });
    expect(res.statusCode).toBe(400);
  });

  it('витрина собирается и проходит контракт', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog/sections', headers: bearer(token) });
    // без LISTENBRAINZ_SIMILAR_ARTISTS в MetaBrainz не уходит ни одного запроса
    const external = fetchSpy.mock.calls.map(([input]) => String(input)).filter((u) => /musicbrainz|listenbrainz/.test(u));
    fetchSpy.mockRestore();
    expect(external).toEqual([]);
    expect(res.statusCode).toBe(200);
    const body = SectionsResponse.parse(res.json());
    expect(body.sections.length).toBeGreaterThan(0);
    expect(body.sections.map((s) => s.id)).not.toContain('nearby');
    // пустым бывает только раздел с честной пометкой
    expect(body.sections.every((s) => s.tracks.length > 0 || !!s.notice)).toBe(true);
    // и Audius, и Internet Archive попали в витрину
    const providers = new Set(body.sections.flatMap((s) => s.tracks.map((t) => t.provider)));
    expect(providers.has('audius')).toBe(true);
    expect(providers.has('archive')).toBe(true);
  });

  it('поиск возвращает треки', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog/search?q=%D0%9A%D0%B8%D0%BD%D0%BE&limit=5', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    const body = TracksResponse.parse(res.json());
    expect(body.tracks.length).toBeGreaterThan(0);
    expect(body.tracks.every((t) => t.playback !== 'unavailable')).toBe(true);
  });

  it('пустой запрос поиска — 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/catalog/search?q=', headers: bearer(token) });
    expect(res.statusCode).toBe(400);
  });

  it('id со слэшем проходит и как есть, и в percent-кодировке', async () => {
    const plain = await ctx.app.inject({ method: 'GET', url: `/v1/catalog/tracks/${ARCHIVE_ID}`, headers: bearer(token) });
    expect(plain.statusCode).toBe(200);
    const track = Track.parse(plain.json());
    expect(track.id).toBe(ARCHIVE_ID);
    expect(track.streamUrl).toBe('https://archive.org/download/ca015_va_cs/101.Etat_Des_Stocks_Klassikkos.mp3');
    expect(track.licenseUrl).toContain('creativecommons.org');

    const encoded = await ctx.app.inject({
      method: 'GET',
      url: `/v1/catalog/tracks/${encodeURIComponent(ARCHIVE_ID)}`,
      headers: bearer(token),
    });
    expect(encoded.statusCode).toBe(200);
    expect(Track.parse(encoded.json()).id).toBe(ARCHIVE_ID);
  });

  it('трека нет — 404 track_not_found', async () => {
    for (const id of ['audius:zzzzzz', 'archive:missing_item/none.mp3', 'не-идентификатор']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/v1/catalog/tracks/${id}`, headers: bearer(token) });
      expect(res.statusCode, id).toBe(404);
      expect(res.json()).toMatchObject({ error: 'track_not_found' });
    }
  });
});
