import type { Track } from '@muzradar/shared';
import { attributionFor, commonsFilePage, licenseLabel, OPEN_MUSIC_LICENSE_URL } from '../attribution';
import { formatSpokenTime, formatTime, trackA11yLabel } from '../format';
import { audibleDurationSec, canList, canStream, hasStreamableAfter } from '../playable';

function track(over: Partial<Track> = {}): Track {
  return {
    id: 'audius:abc',
    provider: 'audius',
    title: 'Ночь',
    artist: 'Кино-клуб',
    album: null,
    artworkUrl: null,
    durationSec: 215,
    playback: 'full',
    previewSec: null,
    genres: [],
    isrc: null,
    licenseUrl: null,
    streamUrl: 'https://s.test/a.mp3',
    ...over,
  };
}

describe('атрибуция источников', () => {
  it('Audius: автор, копирайт, OML и ссылка на лицензию', () => {
    const a = attributionFor(track());
    expect(a.provider).toBe('Audius');
    expect(a.credit).toContain('© Кино-клуб');
    expect(a.credit).toContain('Open Music License');
    expect(a.license).toEqual({ label: 'Open Music License', url: OPEN_MUSIC_LICENSE_URL });
  });

  it('Jamendo: автор, Jamendo и обратная ссылка на трек', () => {
    const a = attributionFor(
      track({ id: 'jamendo:1204669', provider: 'jamendo', licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' }),
    );
    expect(a.provider).toBe('Jamendo');
    expect(a.credit).toBe('Кино-клуб на Jamendo, CC BY-NC-SA 3.0.');
    expect(a.source?.url).toBe('https://www.jamendo.com/track/1204669');
    expect(a.license).toEqual({ label: 'CC BY-NC-SA 3.0', url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' });
  });

  it('Internet Archive: лицензия CC и страница элемента', () => {
    const a = attributionFor(
      track({
        id: 'archive:ntl042/01-track.mp3',
        provider: 'archive',
        licenseUrl: 'http://creativecommons.org/licenses/by/4.0/',
      }),
    );
    expect(a.provider).toBe('Internet Archive');
    expect(a.credit).toContain('CC BY 4.0');
    expect(a.source?.url).toBe('https://archive.org/details/ntl042');
  });

  it('Wikimedia Commons распознаётся по ссылке на поток, в т. ч. на mp3-транскод', () => {
    const stream =
      'https://upload.wikimedia.org/wikipedia/commons/transcoded/5/51/Finale_Tchaikovsky_Symphony_No_4.ogg/Finale_Tchaikovsky_Symphony_No_4.ogg.mp3';
    const a = attributionFor(
      track({ id: 'archive:commons-finale', provider: 'archive', streamUrl: stream, licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/' }),
    );
    expect(a.provider).toBe('Wikimedia Commons');
    expect(a.credit).toContain('Общественное достояние');
    expect(a.source?.url).toBe('https://commons.wikimedia.org/wiki/File:Finale_Tchaikovsky_Symphony_No_4.ogg');
    expect(commonsFilePage('https://upload.wikimedia.org/wikipedia/commons/a/ab/Some.ogg')).toBe(
      'https://commons.wikimedia.org/wiki/File:Some.ogg',
    );
  });

  it('метка лицензии по ссылке', () => {
    expect(licenseLabel('https://creativecommons.org/licenses/by-nc-nd/2.5/')).toBe('CC BY-NC-ND 2.5');
    expect(licenseLabel('https://creativecommons.org/publicdomain/zero/1.0/')).toBe('CC0 — общественное достояние');
    expect(licenseLabel(null)).toBeNull();
    expect(licenseLabel('https://example.org/terms')).toBe('Условия лицензии');
  });
});

describe('что можно играть', () => {
  it('недоступные и запрещённые источники не показываются и не играют', () => {
    expect(canList(track())).toBe(true);
    expect(canList(track({ playback: 'unavailable' }))).toBe(false);
    expect(canList(track({ provider: 'deezer' }))).toBe(false);
    expect(canList(track({ provider: 'itunes', playback: 'preview' }))).toBe(false);
    expect(canStream(track({ streamUrl: null }))).toBe(false);
  });

  it('длительность превью — длина отрывка', () => {
    expect(audibleDurationSec(track({ playback: 'preview', previewSec: 30 }))).toBe(30);
    expect(audibleDurationSec(track())).toBe(215);
  });

  it('есть ли что играть дальше', () => {
    const q = [track(), track({ streamUrl: null }), track({ playback: 'unavailable' })];
    expect(hasStreamableAfter(q, 0)).toBe(false);
    expect(hasStreamableAfter([track(), track()], 0)).toBe(true);
    expect(hasStreamableAfter([track()], -1)).toBe(false);
  });
});

describe('формат времени', () => {
  it('минуты и часы', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(83.9)).toBe('1:23');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(Number.NaN)).toBe('0:00');
  });

  it('для диктора', () => {
    expect(formatSpokenTime(83)).toBe('1 мин 23 с');
    expect(formatSpokenTime(0)).toBe('0 с');
    expect(formatSpokenTime(3600)).toBe('1 ч');
  });

  it('подпись карточки говорит об отрывке', () => {
    expect(trackA11yLabel(track({ playback: 'preview', previewSec: 30 }))).toBe('Ночь, Кино-клуб, отрывок 30 секунд');
  });
});
