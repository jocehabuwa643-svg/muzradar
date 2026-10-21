import type { Track } from '@muzradar/shared';
import { TrackId } from '@muzradar/shared';
import { z } from 'zod';
import { GENRE_VOCABULARY } from '../genres.ts';
import type { HttpClient } from '../http.ts';
import { MOOD_VOCABULARY, uniq } from '../moods.ts';
import { decodeRef, encodeRef, matchesLanguage } from '../normalize.ts';
import type { CatalogProvider, ProviderQuery } from '../types.ts';
import { durationOk, fetchLimit, isNotFound, stripHtml } from './common.ts';

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
export const COMMONS_FILE_PAGE = 'https://commons.wikimedia.org/wiki/File:';
/** Раздел «Классика»: у Commons нет жанров, поэтому запрос по умолчанию — про классику. */
export const COMMONS_DEFAULT_TERMS = 'classical';

const ExtValue = z
  .object({ value: z.union([z.string(), z.number()]).nullish() })
  .nullish()
  .catch(null)
  .transform((v) => {
    const raw = v?.value;
    return raw === null || raw === undefined ? null : String(raw);
  });

const ImageInfo = z.object({
  url: z.string(),
  descriptionurl: z.string().nullish(),
  duration: z.number().nullish(),
  mediatype: z.string().nullish(),
  extmetadata: z
    .object({
      ObjectName: ExtValue,
      Artist: ExtValue,
      LicenseShortName: ExtValue,
      LicenseUrl: ExtValue,
    })
    .partial()
    .nullish()
    .catch(null),
});

const CommonsPage = z.object({
  title: z.string(),
  imageinfo: z.array(ImageInfo).nonempty(),
});
export type CommonsPage = z.infer<typeof CommonsPage>;

/** Страницы приходят объектом (`pages: { "123": {…} }`) или массивом при formatversion=2. */
const CommonsResponse = z.object({
  query: z
    .object({ pages: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullish() })
    .nullish()
    .catch(null),
});

/**
 * Только общественное достояние и свободные CC-лицензии без NC/ND:
 * приложение не должно зависеть от будущего решения о монетизации.
 */
export function commonsLicenseOk(shortName: string | null): boolean {
  if (!shortName) return false;
  const v = shortName.trim();
  if (/n[cd]\b|non-?commercial|no\s?deriv/i.test(v)) return false;
  if (/^(?:public domain|pd|cc0|cc[ -]zero)/i.test(v)) return true;
  return /^cc[ -]by(?:[ -]sa)?(?:[ -]\d+(?:\.\d+)?)?$/i.test(v);
}

/** Commons отдаёт .ogg/.flac; mp3 существует только как перекодировка (iOS не играет Ogg). */
const TRANSCODABLE: ReadonlySet<string> = new Set(['ogg', 'oga', 'flac', 'wav', 'opus']);
const UPLOAD_MARKER = '/wikipedia/commons/';

export function commonsAudioUrl(fileUrl: string): string | null {
  const clean = (fileUrl.split('?')[0] ?? '').trim();
  const at = clean.indexOf(UPLOAD_MARKER);
  if (at < 0) return null;
  const prefix = clean.slice(0, at + UPLOAD_MARKER.length);
  const rest = clean.slice(at + UPLOAD_MARKER.length);
  if (rest.startsWith('transcoded/')) return null;
  const name = rest.slice(rest.lastIndexOf('/') + 1);
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'mp3') return clean;
  if (!TRANSCODABLE.has(ext)) return null;
  return `${prefix}transcoded/${rest}/${name}.mp3`;
}

/** «File:Finale Tchaikovsky Symphony No 4.ogg» → «Finale_Tchaikovsky_Symphony_No_4.ogg». */
export function commonsFileName(title: string): string {
  return title.replace(/^\s*(?:File|Файл):\s*/i, '').replace(/\s+/g, '_');
}

/** Поисковый запрос CirrusSearch: операторы пользователя не должны ломать `filetype:audio`. */
function searchTerms(query: ProviderQuery): string {
  if (query.text) {
    const clean = query.text
      .normalize('NFC')
      .replace(/[:"~*?\\()[\]{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (clean) return clean;
  }
  const words = uniq([
    ...(query.genres ?? []).flatMap((g) => GENRE_VOCABULARY[g].archive),
    ...(query.moods ?? []).flatMap((m) => MOOD_VOCABULARY[m].archive),
  ]).slice(0, 6);
  return words.length > 0 ? words.map((w) => `"${w}"`).join(' OR ') : COMMONS_DEFAULT_TERMS;
}

export interface CommonsProviderOptions {
  http: HttpClient;
}

/** Wikimedia Commons: общественное достояние и свободные CC — прежде всего классика. */
export class CommonsProvider implements CatalogProvider {
  readonly id = 'commons' as const;
  readonly enabled = true;
  private readonly http: HttpClient;

  constructor(opts: CommonsProviderOptions) {
    this.http = opts.http;
  }

  toTrack(page: CommonsPage): Track | null {
    const info = page.imageinfo[0];
    if (!info) return null;
    if (info.mediatype && info.mediatype.toUpperCase() !== 'AUDIO') return null;
    const meta = info.extmetadata;
    if (!commonsLicenseOk(meta?.LicenseShortName ?? null)) return null;
    const durationSec = Math.max(0, Math.round(info.duration ?? 0));
    // Длительность у Commons всегда известна: 0 — значит это не аудио.
    if (durationSec <= 0 || !durationOk(durationSec)) return null;
    const streamUrl = commonsAudioUrl(info.url);
    if (!streamUrl) return null;

    const fileName = commonsFileName(page.title);
    const ref = encodeRef(fileName);
    if (!ref) return null;
    const id = `commons:${ref}`;
    if (!TrackId.safeParse(id).success) return null;

    const objectName = meta?.ObjectName ? stripHtml(meta.ObjectName) : '';
    const title = objectName || fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    const artist = (meta?.Artist ? stripHtml(meta.Artist) : '') || 'Wikimedia Commons';
    const pageUrl = info.descriptionurl?.split('?')[0] || `${COMMONS_FILE_PAGE}${encodeURIComponent(fileName)}`;

    return {
      id,
      provider: 'commons',
      title: title.slice(0, 200),
      artist: artist.slice(0, 200),
      album: null,
      artworkUrl: null,
      durationSec,
      playback: 'full',
      previewSec: null,
      genres: [],
      isrc: null,
      licenseUrl: meta?.LicenseUrl ?? null,
      streamUrl,
      pageUrl,
    };
  }

  private pages(raw: unknown): CommonsPage[] {
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
    return list.flatMap((item) => {
      const parsed = CommonsPage.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  private async call(params: Record<string, string>, query: ProviderQuery | null, signal: AbortSignal): Promise<Track[]> {
    const sp = new URLSearchParams({
      action: 'query',
      format: 'json',
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata|mediatype',
      ...params,
    });
    const res = await this.http.getJson(`${COMMONS_API}?${sp}`, CommonsResponse, signal);
    const tracks = this.pages(res.query?.pages)
      .map((page) => this.toTrack(page))
      .filter((t): t is Track => t !== null);
    if (!query) return tracks;
    return tracks.filter((t) => matchesLanguage(t, query.language)).slice(0, query.limit);
  }

  search(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    const params: Record<string, string> = {
      generator: 'search',
      gsrsearch: `filetype:audio ${searchTerms(query)}`,
      gsrnamespace: '6',
      gsrlimit: String(fetchLimit(query, 50)),
    };
    if (query.offset) params.gsroffset = String(query.offset);
    return this.call(params, query, signal);
  }

  /** У Commons нет ни трендов, ни новинок — отдаём тот же отбор общественного достояния. */
  trending(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    return this.search(query, signal);
  }

  latest(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    return this.search(query, signal);
  }

  async resolve(externalId: string, signal: AbortSignal): Promise<Track | null> {
    const fileName = decodeRef(externalId);
    if (!fileName || fileName.includes('|')) return null;
    try {
      const [track] = await this.call({ titles: `File:${fileName}` }, null, signal);
      return track ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
