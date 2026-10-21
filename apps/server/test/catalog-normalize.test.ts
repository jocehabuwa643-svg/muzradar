import type { Track } from '@muzradar/shared';
import { describe, expect, it } from 'vitest';
import {
  dedupKey,
  decodeRef,
  encodeRef,
  firstArtist,
  markVerified,
  mergeTracks,
  normalizeText,
  parseTitle,
  sameDuration,
  sourceRank,
  transliterate,
} from '../src/modules/catalog/normalize.ts';

function track(over: Partial<Track> & Pick<Track, 'id' | 'provider' | 'title' | 'artist'>): Track {
  return {
    album: null,
    artworkUrl: null,
    durationSec: 284,
    playback: 'full',
    previewSec: null,
    genres: [],
    isrc: null,
    licenseUrl: null,
    streamUrl: 'https://example.com/a.mp3',
    pageUrl: null,
    ...over,
  };
}

describe('нормализация', () => {
  it('ГОСТ 7.79-Б: кириллица и латиница сходятся', () => {
    expect(transliterate('Кино')).toBe('Kino');
    expect(normalizeText('Кино')).toBe(normalizeText('Kino'));
    expect(normalizeText('ЁЛКА')).toBe(normalizeText('Елка'));
    expect(normalizeText('Beyoncé')).toBe(normalizeText('Beyonce'));
  });

  it('мусор из названия убирается, версия сохраняется отдельно', () => {
    expect(parseTitle('Группа крови (Official Video)').base).toBe('Группа крови');
    expect(parseTitle('Gruppa krovi (2009 Remastered)').base).toBe('Gruppa krovi');
    expect(parseTitle('Кукушка feat. Полина Гагарина').base).toBe('Кукушка');
    expect(parseTitle('Звезда по имени Солнце (Live)').version).toBe('live');
    expect(parseTitle('Пачка сигарет (DJ Smash Remix)').version).toBe('remix');
    expect(parseTitle('Видели ночь').version).toBe('');
  });

  it('берётся первый исполнитель', () => {
    expect(firstArtist('Кино & Виктор Цой')).toBe('Кино');
    expect(firstArtist('Nicolai Heidlas, Kevin MacLeod')).toBe('Nicolai Heidlas');
    expect(firstArtist('Artist feat. Other')).toBe('Artist');
  });
});

describe('ключ дедупликации', () => {
  it('«Кино — Группа крови» и «Kino - Gruppa krovi (Remastered)» — один ключ', () => {
    const a = dedupKey({ artist: 'Кино', title: 'Группа крови' });
    const b = dedupKey({ artist: 'Kino', title: 'Gruppa krovi (Remastered)' });
    expect(a).toBe(b);
  });

  it('концертная запись не сливается со студийной', () => {
    const studio = dedupKey({ artist: 'Кино', title: 'Группа крови' });
    const live = dedupKey({ artist: 'Кино', title: 'Группа крови (Live)' });
    expect(live).not.toBe(studio);
  });

  it('«Артист - Название» в заголовке раскрывается', () => {
    expect(dedupKey({ artist: 'Кино', title: 'Кино - Группа крови' })).toBe(dedupKey({ artist: 'Кино', title: 'Группа крови' }));
  });

  it('длительность сравнивается с допуском ±3 с', () => {
    expect(sameDuration(284, 286)).toBe(true);
    expect(sameDuration(284, 292)).toBe(false);
    expect(sameDuration(284, 0)).toBe(true);
  });
});

describe('слияние источников', () => {
  it('полный трек побеждает отрывок, проверенный Audius — Jamendo, IA и Commons', () => {
    const verified = markVerified(track({ id: 'audius:1', provider: 'audius', title: 'Группа крови', artist: 'Кино' }));
    const jam = track({ id: 'jamendo:2', provider: 'jamendo', title: 'Gruppa krovi', artist: 'Kino' });
    const ia = track({ id: 'archive:x/y.mp3', provider: 'archive', title: 'Gruppa krovi', artist: 'Kino' });
    expect(sourceRank(verified)).toBeLessThan(sourceRank(jam));
    expect(sourceRank(jam)).toBeLessThan(sourceRank(ia));

    const preview = track({ id: 'audius:3', provider: 'audius', title: 'Группа крови', artist: 'Кино', playback: 'preview', previewSec: 30 });
    expect(sourceRank(jam)).toBeLessThan(sourceRank(preview));
    // непроверенный загрузчик Audius — ниже всех: риск перезалива
    const unverified = track({ id: 'audius:4', provider: 'audius', title: 'Группа крови', artist: 'Кино' });
    expect(sourceRank(unverified)).toBeGreaterThan(sourceRank(ia));

    const merged = mergeTracks([ia, jam, verified]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('audius:1');
  });

  it('разные версии остаются разными треками', () => {
    const studio = track({ id: 'audius:1', provider: 'audius', title: 'Группа крови', artist: 'Кино' });
    const live = track({ id: 'jamendo:2', provider: 'jamendo', title: 'Группа крови (Live)', artist: 'Кино' });
    expect(mergeTracks([studio, live])).toHaveLength(2);
  });

  it('ISRC склеивает даже при разных названиях', () => {
    const a = track({ id: 'audius:1', provider: 'audius', title: 'Blood Type', artist: 'Kino', isrc: 'RUB421401403' });
    const b = track({ id: 'jamendo:2', provider: 'jamendo', title: 'Группа крови', artist: 'Кино', isrc: 'rub421401403' });
    expect(mergeTracks([a, b])).toHaveLength(1);
  });

  it('обложка и ISRC добираются из проигравшего источника', () => {
    const winner = markVerified(track({ id: 'audius:1', provider: 'audius', title: 'Гость', artist: 'Кино' }));
    const loser = track({ id: 'jamendo:2', provider: 'jamendo', title: 'Гость', artist: 'Кино', artworkUrl: 'https://img/1.jpg', isrc: 'RU1234567890' });
    const [merged] = mergeTracks([winner, loser]);
    expect(merged?.id).toBe('audius:1');
    expect(merged?.artworkUrl).toBe('https://img/1.jpg');
    expect(merged?.isrc).toBe('RU1234567890');
  });
});

describe('идентификатор файла в id трека', () => {
  it('допустимое имя идёт как есть', () => {
    expect(encodeRef('101.Etat_Des_Stocks.mp3')).toBe('101.Etat_Des_Stocks.mp3');
  });

  it('имя со скобками и кириллицей кодируется обратимо', () => {
    const name = 'Чайковский, П. И. - Вальс (отрывок).ogg';
    const ref = encodeRef(name);
    expect(ref).toMatch(/^b64\.[A-Za-z0-9_-]+$/);
    expect(decodeRef(ref as string)).toBe(name);
  });

  it('слишком длинное имя пропускается', () => {
    expect(encodeRef('я'.repeat(200))).toBeNull();
  });
});
