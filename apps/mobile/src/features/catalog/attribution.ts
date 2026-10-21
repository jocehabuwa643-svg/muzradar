import type { Track } from '@muzradar/shared';

export interface AttributionLink {
  label: string;
  url: string;
}

export interface Attribution {
  /** Кто дал трек: «Audius», «Jamendo»… */
  provider: string;
  /** Строка кредита под плеером — то, чего требуют условия источника. */
  credit: string;
  license: AttributionLink | null;
  /** Обратная ссылка на трек у источника. */
  source: AttributionLink | null;
}

export const OPEN_MUSIC_LICENSE_URL = 'https://openaudiofoundation.org/open-music-license.pdf';

/** «https://creativecommons.org/licenses/by-nc-sa/4.0/» → «CC BY-NC-SA 4.0». */
export function licenseLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d+(?:\.\d+)?)/i.exec(url);
  if (cc) return `CC ${(cc[1] ?? '').toUpperCase()} ${cc[2] ?? ''}`.trim();
  if (/creativecommons\.org\/publicdomain\/zero/i.test(url)) return 'CC0 — общественное достояние';
  if (/creativecommons\.org\/publicdomain\/mark/i.test(url)) return 'Общественное достояние';
  if (/openaudiofoundation\.org/i.test(url)) return 'Open Music License';
  if (/public[\s_-]?domain/i.test(url)) return 'Общественное достояние';
  return 'Условия лицензии';
}

function externalId(track: Track): string {
  const i = track.id.indexOf(':');
  return i >= 0 ? track.id.slice(i + 1) : track.id;
}

/** Страница файла на Commons по прямой ссылке upload.wikimedia.org (в т. ч. на mp3-транскод). */
export function commonsFilePage(streamUrl: string | null): string | null {
  if (!streamUrl) return null;
  const m = /upload\.wikimedia\.org\/wikipedia\/commons\/(?:transcoded\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i.exec(streamUrl);
  const file = m?.[1];
  return file ? `https://commons.wikimedia.org/wiki/File:${file}` : null;
}

function isCommons(track: Track): boolean {
  return (
    track.provider === 'commons' ||
    track.id.startsWith('commons:') ||
    /wikimedia\.org/i.test(track.streamUrl ?? '') ||
    /wikimedia\.org/i.test(track.licenseUrl ?? '')
  );
}

function link(label: string, url: string | null): AttributionLink | null {
  return url ? { label, url } : null;
}

/**
 * Атрибуция по условиям источника:
 * Audius (OML) — автор, копирайт, упоминание OML, ссылка на трек;
 * Jamendo — автор, Jamendo и обратная ссылка на трек;
 * Internet Archive и Commons — автор, лицензия и источник.
 */
export function attributionFor(track: Track): Attribution {
  const license = licenseLabel(track.licenseUrl);
  const id = externalId(track);
  // Страница трека от сервера точнее любой ссылки, собранной из id
  const page = track.pageUrl ?? null;

  const commons = (): Attribution => ({
    provider: 'Wikimedia Commons',
    credit: `${track.artist}. Запись из Wikimedia Commons${license ? `, ${license}` : ''}.`,
    license: link(license ?? 'Лицензия', track.licenseUrl),
    source: link('Файл на Commons', page ?? commonsFilePage(track.streamUrl) ?? 'https://commons.wikimedia.org'),
  });

  if (isCommons(track)) return commons();

  switch (track.provider) {
    case 'commons':
      return commons();
    case 'audius':
      return {
        provider: 'Audius',
        credit: `© ${track.artist}. Опубликовано автором на Audius и распространяется по Open Music License.`,
        license: { label: 'Open Music License', url: track.licenseUrl ?? OPEN_MUSIC_LICENSE_URL },
        source: { label: page ? 'Трек на Audius' : 'Audius', url: page ?? 'https://audius.co' },
      };
    case 'jamendo':
      return {
        provider: 'Jamendo',
        credit: `${track.artist} на Jamendo${license ? `, ${license}` : ', лицензия Creative Commons'}.`,
        license: link(license ?? 'Лицензия', track.licenseUrl),
        source: { label: 'Трек и автор на Jamendo', url: page ?? `https://www.jamendo.com/track/${encodeURIComponent(id)}` },
      };
    case 'archive': {
      const identifier = id.split('/')[0] ?? id;
      return {
        provider: 'Internet Archive',
        credit: `${track.artist}. Запись из Internet Archive${license ? `, ${license}` : ''}.`,
        license: link(license ?? 'Лицензия', track.licenseUrl),
        source: { label: 'Страница в Internet Archive', url: page ?? `https://archive.org/details/${encodeURIComponent(identifier)}` },
      };
    }
    case 'itunes':
      return { provider: 'iTunes', credit: 'Предоставлено iTunes.', license: null, source: null };
    case 'deezer':
      return { provider: 'Deezer', credit: 'Deezer.', license: null, source: null };
  }
}
