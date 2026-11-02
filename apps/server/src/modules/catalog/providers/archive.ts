import type { Track } from '@muzradar/shared';
import { TrackId } from '@muzradar/shared';
import { z } from 'zod';
import { CACHE_TTL, TtlCache } from '../cache.ts';
import { GENRE_VOCABULARY } from '../genres.ts';
import { lenientArray, mapLimit, type HttpClient } from '../http.ts';
import { MOOD_VOCABULARY, uniq } from '../moods.ts';
import { decodeRef, encodeRef, interleave, sameArtist, splitArtistTitle } from '../normalize.ts';
import type { CatalogProvider, ProviderQuery } from '../types.ts';
import { durationOk, isNotFound } from './common.ts';

export const IA_BASE = 'https://archive.org';

/** Только CC и public domain: условия IA разрешают использование лишь под заявленной лицензией. */
export const IA_LICENSE_RE = /^https?:\/\/(?:www\.)?creativecommons\.org\/(?:licenses|publicdomain)\//i;
/** 78rpm/georgeblood — предмет иска UMG (урегулирован в 2025), лицензий там нет. */
const EXCLUDED_COLLECTIONS: ReadonlySet<string> = new Set(['78rpm', 'georgeblood']);
const IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** С одного альбома в витрину — не больше трёх треков. */
const TRACKS_PER_ITEM = 3;
/** Параллельных запросов метаданных на один вызов (на хост ещё действует общий лимит 2). */
const RESOLVE_PARALLEL = 2;
/**
 * Сколько после поиска ждём метаданные альбомов. Один медленный /metadata (замерено до 1,8 с)
 * не должен обнулять весь ответ: что успело — отдаём, остальное выпадает.
 */
export const ARCHIVE_METADATA_PHASE_MS = 4_000;

const firstString = z
  .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
  .nullish()
  .catch(null)
  .transform((v) => {
    const first = Array.isArray(v) ? v[0] : v;
    const s = first === null || first === undefined ? '' : String(first).trim();
    return s || null;
  });

const stringList = z
  .union([z.string(), z.array(z.string())])
  .nullish()
  .catch(null)
  .transform((v) =>
    (Array.isArray(v) ? v : v ? v.split(';') : []).map((s) => s.trim()).filter((s) => s !== ''),
  );

const SearchDoc = z.object({
  identifier: z.string().regex(IDENTIFIER_RE),
  licenseurl: firstString,
  collection: stringList,
});

const SearchResponse = z.object({ response: z.object({ docs: lenientArray(SearchDoc) }) });

const IaFile = z.object({
  name: z.string().min(1),
  source: firstString,
  format: firstString,
  original: firstString,
  title: firstString,
  artist: firstString,
  creator: firstString,
  album: firstString,
  track: firstString,
  length: firstString,
});
type IaFile = z.infer<typeof IaFile>;

const ItemMetadata = z.object({
  metadata: z
    .object({
      identifier: z.string(),
      title: firstString,
      creator: firstString,
      licenseurl: firstString,
      collection: stringList,
      subject: stringList,
    })
    .nullish()
    .catch(null),
  files: lenientArray(IaFile),
});
export type ItemMetadata = z.infer<typeof ItemMetadata>;

/** Длина в метаданных IA бывает и секундами ('262.28'), и временем ('04:22', '1:02:03'). */
export function parseIaLength(value: string | null | undefined): number {
  if (!value) return 0;
  const v = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (/^\d{1,3}(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(v)) {
    return v.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }
  return 0;
}

function luceneTerm(term: string): string {
  const clean = term.replace(/["\\]/g, ' ').trim();
  return /[\s:&/+-]/.test(clean) ? `"${clean}"` : clean;
}

/** Свободный текст без синтаксиса Lucene: пользователь не должен ломать фильтр лицензий. */
function luceneText(text: string): string {
  return text
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\b(?:AND|OR|NOT|TO)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

export function buildArchiveQuery(query: ProviderQuery): string {
  const parts = ['collection:netlabels', 'mediatype:audio', 'licenseurl:(*creativecommons.org*)'];
  const subjects = uniq([
    ...(query.genres ?? []).flatMap((g) => GENRE_VOCABULARY[g].archive),
    ...(query.moods ?? []).flatMap((m) => MOOD_VOCABULARY[m].archive),
  ]);
  if (subjects.length > 0) parts.push(`subject:(${subjects.map(luceneTerm).join(' OR ')})`);
  const text = query.text ? luceneText(query.text) : '';
  if (text) parts.push(`(title:(${text}) OR creator:(${text}) OR subject:(${text}))`);
  const russian = query.language === 'ru' || (query.genres ?? []).some((g) => GENRE_VOCABULARY[g].russian);
  if (russian) parts.push('(language:(rus OR russian) OR subject:(russian OR русский OR russia))');
  if (query.language === 'foreign') parts.push('NOT language:(rus OR russian)');
  parts.push('NOT collection:(78rpm OR georgeblood)');
  return parts.join(' AND ');
}

function streamUrl(identifier: string, name: string): string {
  return `${IA_BASE}/download/${identifier}/${name.split('/').map(encodeURIComponent).join('/')}`;
}

function cleanFileTitle(file: IaFile): string {
  const raw = file.title ?? file.name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const spaced = raw.includes(' ') ? raw : raw.replace(/_/g, ' ');
  return spaced.replace(/^\d{1,3}\s*[.)_-]\s*/, '').trim() || raw;
}

function licensed(meta: NonNullable<ItemMetadata['metadata']>): boolean {
  return !!meta.licenseurl && IA_LICENSE_RE.test(meta.licenseurl) && !meta.collection.some((c) => EXCLUDED_COLLECTIONS.has(c.toLowerCase()));
}

/**
 * Треки элемента: только «VBR MP3» (Ogg не играет AVPlayer на iOS).
 * Если есть оригинал в VBR MP3, его производная `_vbr.mp3` — дубль и пропускается.
 */
export function archiveItemTracks(identifier: string, item: ItemMetadata): Array<{ file: string; track: Track }> {
  const meta = item.metadata;
  if (!meta || !licensed(meta)) return [];
  const mp3 = item.files.filter((f) => f.format === 'VBR MP3');
  const originals = new Set(mp3.filter((f) => f.source === 'original').map((f) => f.name));
  const files = mp3
    .filter((f) => !(f.source === 'derivative' && f.original && originals.has(f.original)))
    .sort((a, b) => (Number.parseInt(a.track ?? '', 10) || 9999) - (Number.parseInt(b.track ?? '', 10) || 9999) || a.name.localeCompare(b.name));

  const itemArtist = meta.creator && !/^various/i.test(meta.creator) ? meta.creator : null;
  const out: Array<{ file: string; track: Track }> = [];
  for (const file of files) {
    const durationSec = parseIaLength(file.length);
    if (!durationOk(durationSec)) continue;
    const ref = encodeRef(file.name);
    if (!ref) continue;
    const id = `archive:${identifier}/${ref}`;
    if (!TrackId.safeParse(id).success) continue;
    const artist = file.artist ?? file.creator ?? itemArtist ?? 'Internet Archive';
    let title = cleanFileTitle(file);
    const split = splitArtistTitle(title);
    if (split && sameArtist(split.artist, artist)) title = split.title;
    out.push({
      file: file.name,
      track: {
        id,
        provider: 'archive',
        title,
        artist,
        album: file.album ?? meta.title ?? null,
        artworkUrl: `${IA_BASE}/services/img/${identifier}`,
        durationSec,
        playback: 'full',
        previewSec: null,
        genres: meta.subject.slice(0, 3),
        isrc: null,
        licenseUrl: meta.licenseurl,
        streamUrl: streamUrl(identifier, file.name),
        pageUrl: `${IA_BASE}/details/${identifier}`,
      },
    });
  }
  return out;
}

export interface ArchiveProviderOptions {
  http: HttpClient;
  now?: () => number;
  metadataPhaseMs?: number;
}

/** Internet Archive: нетлейблы под CC/PD. Поиск даёт альбомы, треки — из /metadata. */
export class ArchiveProvider implements CatalogProvider {
  readonly id = 'archive' as const;
  readonly enabled = true;
  private readonly http: HttpClient;
  private readonly items: TtlCache<ItemMetadata>;
  private readonly metadataPhaseMs: number;

  constructor(opts: ArchiveProviderOptions) {
    this.http = opts.http;
    this.items = new TtlCache({ max: 500, ...(opts.now ? { now: opts.now } : {}) });
    this.metadataPhaseMs = opts.metadataPhaseMs ?? ARCHIVE_METADATA_PHASE_MS;
  }

  private metadata(identifier: string, signal: AbortSignal): Promise<ItemMetadata> {
    return this.items.wrap(identifier, CACHE_TTL.archiveItemMs, () =>
      this.http.getJson(`${IA_BASE}/metadata/${identifier}`, ItemMetadata, signal),
    );
  }

  private async run(query: ProviderQuery, sort: string | null, signal: AbortSignal): Promise<Track[]> {
    const rows = Math.min(6, Math.max(2, Math.ceil(query.limit / TRACKS_PER_ITEM)));
    const page = Math.floor((query.offset ?? 0) / rows) + 1;
    const sp = new URLSearchParams({ q: buildArchiveQuery(query), rows: String(rows), page: String(page), output: 'json' });
    for (const f of ['identifier', 'licenseurl', 'collection']) sp.append('fl[]', f);
    if (sort) sp.append('sort[]', sort);
    const res = await this.http.getJson(`${IA_BASE}/advancedsearch.php?${sp}`, SearchResponse, signal);
    const docs = res.response.docs.filter(
      (d) => !!d.licenseurl && IA_LICENSE_RE.test(d.licenseurl) && !d.collection.some((c) => EXCLUDED_COLLECTIONS.has(c.toLowerCase())),
    );
    const phase = AbortSignal.any([signal, AbortSignal.timeout(this.metadataPhaseMs)]);
    const settled = await mapLimit(docs, RESOLVE_PARALLEL, async (doc) =>
      archiveItemTracks(doc.identifier, await this.metadata(doc.identifier, phase)).slice(0, TRACKS_PER_ITEM),
    );
    if (signal.aborted) throw signal.reason;
    const perItem = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value.map((x) => x.track)] : []));
    return interleave(perItem).slice(0, query.limit);
  }

  search(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    const sort = query.sort === 'popular' ? 'downloads desc' : query.sort === 'recent' ? 'publicdate desc' : query.text ? null : 'downloads desc';
    return this.run(query, sort, signal);
  }

  trending(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    return this.run(query, 'downloads desc', signal);
  }

  latest(query: ProviderQuery, signal: AbortSignal): Promise<Track[]> {
    return this.run(query, 'publicdate desc', signal);
  }

  async resolve(externalId: string, signal: AbortSignal): Promise<Track | null> {
    const slash = externalId.indexOf('/');
    if (slash <= 0) return null;
    const identifier = externalId.slice(0, slash);
    const name = decodeRef(externalId.slice(slash + 1));
    if (!IDENTIFIER_RE.test(identifier) || !name) return null;
    try {
      const item = await this.metadata(identifier, signal);
      return archiveItemTracks(identifier, item).find((x) => x.file === name)?.track ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
