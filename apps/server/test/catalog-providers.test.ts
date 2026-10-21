import { TrackId, type Track } from '@muzradar/shared';
import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/modules/catalog/http.ts';
import {
  archiveItemTracks,
  ArchiveProvider,
  buildArchiveQuery,
  IA_LICENSE_RE,
  parseIaLength,
  type ItemMetadata,
} from '../src/modules/catalog/providers/archive.ts';
import { audiusPlayback, AudiusProvider, isLikelyPirated, type AudiusTrack } from '../src/modules/catalog/providers/audius.ts';
import { commonsAudioUrl, commonsLicenseOk, CommonsProvider } from '../src/modules/catalog/providers/commons.ts';
import { JamendoProvider } from '../src/modules/catalog/providers/jamendo.ts';
import type { ProviderQuery } from '../src/modules/catalog/types.ts';
import { fixture, hang, openSignal, testHttp } from './fixtures/catalog/harness.ts';

const q = (partial: Partial<ProviderQuery> = {}): ProviderQuery => ({ limit: 20, ...partial });

function audius(over: Partial<AudiusTrack> = {}): AudiusTrack {
  return {
    id: 'abc123',
    title: 'Track',
    user: { id: 'u1', handle: 'someone', name: 'Someone', is_verified: false },
    ...over,
  } as AudiusTrack;
}

describe('Audius: статус доступности', () => {
  const streamable = { is_streamable: true, is_available: true, is_delete: false, access: { stream: true } };

  it('full только при полном наборе признаков', () => {
    expect(audiusPlayback(audius(streamable), undefined)).toBe('full');
  });

  it('не стримится / нет доступа / за воротами — preview при наличии отрывка', () => {
    expect(audiusPlayback(audius({ ...streamable, is_streamable: false, preview_cid: 'cid' }), undefined)).toBe('preview');
    expect(audiusPlayback(audius({ ...streamable, access: { stream: false }, preview_cid: 'cid' }), undefined)).toBe('preview');
    expect(audiusPlayback(audius({ ...streamable, is_stream_gated: true, preview_cid: 'cid' }), undefined)).toBe('preview');
  });

  it('без отрывка недоступные треки — unavailable', () => {
    expect(audiusPlayback(audius({ ...streamable, is_stream_gated: true }), undefined)).toBe('unavailable');
  });

  it('удалённый или недоступный трек не спасает даже отрывок', () => {
    expect(audiusPlayback(audius({ ...streamable, is_delete: true, preview_cid: 'cid' }), undefined)).toBe('unavailable');
    expect(audiusPlayback(audius({ ...streamable, is_available: false, preview_cid: 'cid' }), undefined)).toBe('unavailable');
  });

  it('allowed_api_keys: full только со своим ключом', () => {
    const gated = audius({ ...streamable, allowed_api_keys: ['AABBCC'], preview_cid: 'cid' });
    expect(audiusPlayback(gated, 'aabbcc')).toBe('full');
    expect(audiusPlayback(gated, 'other')).toBe('preview');
    expect(audiusPlayback(gated, undefined)).toBe('preview');
    expect(audiusPlayback(audius({ ...streamable, allowed_api_keys: null }), undefined)).toBe('full');
  });
});

describe('Audius: фильтр перезаливов', () => {
  it('проверенный автор проходит всегда', () => {
    expect(isLikelyPirated(audius({ title: 'Кино - Кукушка', user: { is_verified: true, handle: 'x', name: 'X' } } as Partial<AudiusTrack>))).toBe(false);
  });

  it('непроверенный автор с чужим именем в «Артист - Название» отбрасывается', () => {
    expect(isLikelyPirated(audius({ title: 'Кино - Кукушка' }))).toBe(true);
  });

  it('непроверенный автор без разделителя проходит', () => {
    expect(isLikelyPirated(audius({ title: 'Кинофилы' }))).toBe(false);
  });

  it('свой трек в формате «Автор - Название» проходит', () => {
    expect(isLikelyPirated(audius({ title: 'Someone - Новый трек' }))).toBe(false);
  });

  it('блок-лист перекрывает всё', () => {
    const blocked = new Set(['user:someone']);
    expect(isLikelyPirated(audius({ title: 'Свой трек' }), blocked)).toBe(true);
  });
});

describe('Audius: поиск по записанному ответу', () => {
  const provider = (apiKey?: string) => {
    const { http, calls } = testHttp([{ match: '/v1/tracks/search', body: fixture('audius-search-kino') }]);
    return {
      calls,
      audius: new AudiusProvider({ http, appName: 'MUZRADAR', ...(apiKey ? { apiKey } : {}) }),
    };
  };

  it('кириллица в запросе уходит в URL, перезаливы и не-музыка отсеяны', async () => {
    const { audius: p, calls } = provider();
    const tracks = await p.search(q({ text: 'Кино' }), openSignal());
    const ids = tracks.map((t) => t.id);

    expect(calls[0]).toContain('query=%D0%9A%D0%B8%D0%BD%D0%BE');
    expect(ids).toContain('audius:l5WdA');
    expect(ids).toContain('audius:kKvaX');
    // перезаливы: «Кино - Кукушка», «Macan - Кино», «MACAN - Кино (…)», «13 КИНО - …»
    expect(ids).not.toContain('audius:93kqwa2');
    expect(ids).not.toContain('audius:dWYbv');
    expect(ids).not.toContain('audius:VRvjMdP');
    expect(ids).not.toContain('audius:7APGR4v');
    // подкасты, начитка и двухсекундный обрывок
    expect(ids).not.toContain('audius:9dxdl7k');
    expect(ids).not.toContain('audius:QYNM54');
    expect(ids).not.toContain('audius:P745p');
    expect(tracks.every((t) => t.playback === 'full')).toBe(true);
    expect(tracks.every((t) => TrackId.safeParse(t.id).success)).toBe(true);
  });

  it('ссылка на страницу и поток: app_name всегда, api_key — когда настроен', async () => {
    const { audius: p } = provider();
    const [track] = (await p.search(q({ text: 'Кино' }), openSignal())).filter((t) => t.id === 'audius:l5WdA');
    expect(track?.title).toBe('КИНО');
    expect(track?.pageUrl).toBe('https://audius.co/quok/кино');
    expect(track?.streamUrl).toBe('https://api.audius.co/v1/tracks/l5WdA/stream?app_name=MUZRADAR');
    expect(track?.licenseUrl).toContain('open-music-license');

    const { audius: keyed, calls } = provider('deadbeef');
    const keyedTracks = await keyed.search(q({ text: 'Кино' }), openSignal());
    expect(keyedTracks[0]?.streamUrl).toContain('api_key=deadbeef');
    expect(calls[0]).toContain('app_name=MUZRADAR');
    expect(calls[0]).toContain('api_key=deadbeef');
  });

  it('resolve отдаёт свежую ссылку на поток', async () => {
    const { http } = testHttp([{ match: '/v1/tracks/YlRbOJ', body: fixture('audius-track') }]);
    const p = new AudiusProvider({ http, appName: 'MUZRADAR' });
    const track = await p.resolve('YlRbOJ', openSignal());
    expect(track?.id).toBe('audius:YlRbOJ');
    expect(track?.playback).toBe('full');
    expect(track?.streamUrl).toContain('/v1/tracks/YlRbOJ/stream?app_name=MUZRADAR');
    expect(track?.artworkUrl).toContain('480x480');
  });

  it('latest падает — подставляются тренды', async () => {
    const { http } = testHttp([
      { match: '/v1/tracks/latest', status: 500 },
      { match: '/v1/tracks/trending', body: fixture('audius-trending-week') },
    ]);
    const p = new AudiusProvider({ http, appName: 'MUZRADAR' });
    const tracks = await p.latest(q(), openSignal());
    expect(tracks.length).toBeGreaterThan(0);
  });
});

describe('Jamendo', () => {
  it('без client_id провайдер выключен и не ходит в сеть', async () => {
    const { http, calls } = testHttp([]);
    const p = new JamendoProvider({ http, clientId: undefined });
    expect(p.enabled).toBe(false);
    expect(await p.search(q({ text: 'jazz' }), openSignal())).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('ошибка приходит с HTTP 200 в теле: headers.code = 5', async () => {
    const { http } = testHttp([{ match: 'api.jamendo.com', body: fixture('jamendo-invalid-client'), status: 200 }]);
    const p = new JamendoProvider({ http, clientId: 'wrong' });
    await expect(p.search(q({ text: 'jazz' }), openSignal())).rejects.toBeInstanceOf(UpstreamError);
    await expect(p.search(q({ text: 'jazz' }), openSignal())).rejects.toThrow(/code 5/);
  });

  it('успешный ответ: mp32, только треки с audio, обратная ссылка и лицензия', async () => {
    const { http, calls } = testHttp([{ match: 'api.jamendo.com', body: fixture('jamendo-tracks') }]);
    const p = new JamendoProvider({ http, clientId: 'testclient' });
    const tracks = await p.search(q({ text: 'sun' }), openSignal());

    expect(calls[0]).toContain('audioformat=mp32');
    expect(calls[0]).toContain('include=musicinfo+licenses');
    expect(calls[0]).toContain('type=single+albumtrack');
    expect(tracks.map((t) => t.id)).toEqual(['jamendo:1886510', 'jamendo:1737038']);
    const [first] = tracks;
    expect(first?.playback).toBe('full');
    expect(first?.licenseUrl).toBe('http://creativecommons.org/licenses/by/3.0/');
    expect(first?.pageUrl).toBe('https://www.jamendo.com/track/1886510');
    expect(first?.streamUrl).toContain('format=mp32');
    expect(first?.genres).toEqual(['pop', 'electronic']);
  });

  it('язык: ru просит API, foreign отсекает русские треки по musicinfo.lang', async () => {
    const { http, calls } = testHttp([{ match: 'api.jamendo.com', body: fixture('jamendo-tracks') }]);
    const p = new JamendoProvider({ http, clientId: 'testclient' });

    await p.search(q({ language: 'ru' }), openSignal());
    expect(calls[0]).toContain('lang=ru');

    const foreign = await p.search(q({ language: 'foreign' }), openSignal());
    expect(foreign.map((t) => t.id)).toEqual(['jamendo:1886510']);
  });
});

describe('Internet Archive', () => {
  it('запрос ограничен нетлейблами под CC и исключает 78rpm/georgeblood', () => {
    const query = buildArchiveQuery(q({ genres: ['ambient'] }));
    expect(query).toContain('collection:netlabels');
    expect(query).toContain('mediatype:audio');
    expect(query).toContain('licenseurl:(*creativecommons.org*)');
    expect(query).toContain('NOT collection:(78rpm OR georgeblood)');
    expect(query).toContain('subject:(ambient)');
  });

  it('длительность читается и секундами, и как мм:сс', () => {
    expect(parseIaLength('262.28')).toBeCloseTo(262.28, 2);
    expect(parseIaLength('04:22')).toBe(262);
    expect(parseIaLength('1:02:03')).toBe(3723);
    expect(parseIaLength(null)).toBe(0);
    expect(parseIaLength('неизвестно')).toBe(0);
  });

  it('берётся только VBR MP3: Ogg и 64Kbps не попадают в выдачу', () => {
    const item = fixture<ItemMetadata>('archive-metadata-ca015');
    const tracks = archiveItemTracks('ca015_va_cs', item);
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((t) => t.file.endsWith('.mp3'))).toBe(true);
    expect(tracks.some((t) => t.file.endsWith('.ogg'))).toBe(false);
    expect(tracks.some((t) => t.file.endsWith('_64kb.mp3'))).toBe(false);
    const [first] = tracks;
    expect(first?.track.durationSec).toBeCloseTo(262.28, 2);
    expect(first?.track.id).toBe('archive:ca015_va_cs/101.Etat_Des_Stocks_Klassikkos.mp3');
    expect(first?.track.streamUrl).toBe('https://archive.org/download/ca015_va_cs/101.Etat_Des_Stocks_Klassikkos.mp3');
    expect(first?.track.artworkUrl).toBe('https://archive.org/services/img/ca015_va_cs');
    expect(first?.track.pageUrl).toBe('https://archive.org/details/ca015_va_cs');
    expect(TrackId.safeParse(first?.track.id).success).toBe(true);
  });

  it('длительность вида мм:сс на самом VBR MP3 тоже читается', () => {
    // синтетический элемент: у записанных ответов мм:сс встречается только на 64Kbps-производной
    const item = {
      metadata: {
        identifier: 'netlabel_demo',
        title: 'Demo EP',
        creator: 'Demo Artist',
        licenseurl: 'http://creativecommons.org/licenses/by/4.0/',
        collection: ['netlabels'],
        subject: ['ambient'],
      },
      files: [{ name: 'a1.mp3', source: 'original', format: 'VBR MP3', length: '04:22', title: 'A1', track: '1' }],
    };
    const tracks = archiveItemTracks('netlabel_demo', item as unknown as ItemMetadata);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.track.durationSec).toBe(262);
  });

  it('элемент без лицензии CC/PD не даёт треков', () => {
    const item = {
      metadata: { identifier: 'x', title: 'X', creator: 'X', licenseurl: null, collection: ['netlabels'], subject: [] },
      files: [{ name: 'a.mp3', source: 'original', format: 'VBR MP3', length: '200', title: 'A' }],
    };
    expect(archiveItemTracks('x', item as unknown as ItemMetadata)).toEqual([]);
    expect(IA_LICENSE_RE.test('http://creativecommons.org/licenses/by-nc-nd/3.0/')).toBe(true);
    expect(IA_LICENSE_RE.test('https://creativecommons.org/publicdomain/mark/1.0/')).toBe(true);
    expect(IA_LICENSE_RE.test('http://example.com/rights')).toBe(false);
  });

  it('выдача поиска фильтруется по лицензии и коллекции ещё до запроса метаданных', async () => {
    const search = {
      response: {
        docs: [
          { identifier: 'ok_item', licenseurl: 'http://creativecommons.org/licenses/by/4.0/', collection: ['netlabels'] },
          { identifier: 'no_license', licenseurl: null, collection: ['netlabels'] },
          { identifier: 'other_license', licenseurl: 'http://example.com/rights', collection: ['netlabels'] },
          { identifier: 'shellac', licenseurl: 'http://creativecommons.org/licenses/by/4.0/', collection: ['78rpm', 'georgeblood'] },
        ],
      },
    };
    const metadata = {
      metadata: {
        identifier: 'ok_item',
        title: 'OK',
        creator: 'Someone',
        licenseurl: 'http://creativecommons.org/licenses/by/4.0/',
        collection: ['netlabels'],
        subject: ['ambient'],
      },
      files: [{ name: 'a1.mp3', source: 'original', format: 'VBR MP3', length: '200', title: 'A1', artist: 'Someone' }],
    };
    const { http, calls } = testHttp([
      { match: 'advancedsearch.php', body: search },
      { match: '/metadata/', body: metadata },
    ]);
    const p = new ArchiveProvider({ http });
    const tracks = await p.search(q({ genres: ['ambient'] }), openSignal());

    expect(calls.filter((u) => u.includes('/metadata/'))).toEqual(['https://archive.org/metadata/ok_item']);
    expect(tracks.map((t) => t.id)).toEqual(['archive:ok_item/a1.mp3']);
  });

  it('зависшие метаданные одного альбома не обнуляют ответ: что успело — отдаётся', async () => {
    const { http } = testHttp([
      { match: 'advancedsearch.php', body: fixture('archive-search') },
      { match: '/metadata/ca015_va_cs', body: fixture('archive-metadata-ca015') },
      { match: '/metadata/', handler: hang },
    ]);
    const p = new ArchiveProvider({ http, metadataPhaseMs: 150 });
    const started = Date.now();
    const tracks = await p.search(q({ language: 'ru', sort: 'popular' }), openSignal());

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((t) => t.id.startsWith('archive:ca015_va_cs/'))).toBe(true);
  });

  it('id со слэшем разбирается обратно в идентификатор и имя файла', async () => {
    const { http } = testHttp([{ match: '/metadata/ca015_va_cs', body: fixture('archive-metadata-ca015') }]);
    const p = new ArchiveProvider({ http });
    const track = await p.resolve('ca015_va_cs/101.Etat_Des_Stocks_Klassikkos.mp3', openSignal());
    expect(track?.id).toBe('archive:ca015_va_cs/101.Etat_Des_Stocks_Klassikkos.mp3');
    expect(track?.playback).toBe('full');
    expect(await p.resolve('ca015_va_cs/нет-такого.mp3', openSignal())).toBeNull();
  });
});

describe('Wikimedia Commons', () => {
  it('разрешены только PD, CC0 и CC BY(-SA)', () => {
    expect(commonsLicenseOk('Public domain')).toBe(true);
    expect(commonsLicenseOk('CC0')).toBe(true);
    expect(commonsLicenseOk('CC BY 2.0')).toBe(true);
    expect(commonsLicenseOk('CC BY-SA 4.0')).toBe(true);
    expect(commonsLicenseOk('CC BY-NC-SA 3.0')).toBe(false);
    expect(commonsLicenseOk('CC BY-ND 3.0')).toBe(false);
    expect(commonsLicenseOk('Fair use')).toBe(false);
    expect(commonsLicenseOk(null)).toBe(false);
  });

  it('ссылка на mp3 — перекодировка, Ogg клиенту не отдаётся', () => {
    expect(commonsAudioUrl('https://upload.wikimedia.org/wikipedia/commons/5/51/Finale_Tchaikovsky_Symphony_No_4.ogg?utm_source=x')).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/transcoded/5/51/Finale_Tchaikovsky_Symphony_No_4.ogg/Finale_Tchaikovsky_Symphony_No_4.ogg.mp3',
    );
    expect(commonsAudioUrl('https://upload.wikimedia.org/wikipedia/commons/1/12/Song.mp3')).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/1/12/Song.mp3',
    );
    expect(commonsAudioUrl('https://upload.wikimedia.org/wikipedia/commons/1/12/Photo.jpg')).toBeNull();
    expect(commonsAudioUrl('https://example.com/a.ogg')).toBeNull();
  });

  it('короткие произношения и несвободные файлы отсеяны, id обратим', async () => {
    const { http, calls } = testHttp([{ match: 'commons.wikimedia.org/w/api.php', body: fixture('commons-search-tchaikovsky') }]);
    const p = new CommonsProvider({ http });
    const tracks = await p.search(q({ text: 'Чайковский' }), openSignal());

    expect(calls[0]).toContain('gsrsearch=filetype%3Aaudio');
    const ids = tracks.map((t) => t.id);
    // 2,3 с — произношение имени, не музыка
    expect(ids.some((id) => id.includes('Ru-Pyotr_Ilyich_Tchaikovsky.ogg'))).toBe(false);
    expect(ids).toContain('commons:Finale_Tchaikovsky_Symphony_No_4.ogg');
    expect(tracks.every((t) => TrackId.safeParse(t.id).success)).toBe(true);
    expect(tracks.every((t) => t.playback === 'full')).toBe(true);
    expect(tracks.every((t) => (t.streamUrl ?? '').endsWith('.mp3'))).toBe(true);

    const finale = tracks.find((t) => t.id === 'commons:Finale_Tchaikovsky_Symphony_No_4.ogg') as Track;
    expect(finale.streamUrl).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/transcoded/5/51/Finale_Tchaikovsky_Symphony_No_4.ogg/Finale_Tchaikovsky_Symphony_No_4.ogg.mp3',
    );
    expect(finale.artist).toContain('Tchaikovsky');
    expect(finale.pageUrl).toContain('commons.wikimedia.org/wiki/File:');

    // имена со скобками и запятыми не проходят в id как есть — они кодируются
    expect(ids.some((id) => id.startsWith('commons:b64.'))).toBe(true);
    // HTML из ObjectName вычищается
    const romeo = tracks.find((t) => t.title.toLowerCase().includes('romeo'));
    expect(romeo?.title).not.toContain('<');
  });
});
