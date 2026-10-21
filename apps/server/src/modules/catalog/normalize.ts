import type { Track } from '@muzradar/shared';

// ─── транслитерация ─────────────────────────────────────────────────────────

/** ГОСТ 7.79-2000, система Б (без диакритики). Ц перед и/е/ы/й — «c», иначе «cz». */
const GOST_B: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'j',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'x', ц: 'cz', ч: 'ch', ш: 'sh', щ: 'shh', ъ: '``', ы: 'y`', ь: '`', э: 'e`', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u`',
};

export function transliterate(text: string): string {
  let out = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const lower = ch.toLowerCase();
    let lat = GOST_B[lower];
    if (lat === undefined) {
      out += ch;
      continue;
    }
    if (lower === 'ц' && /^[иеыйieyj]/iu.test(chars[i + 1] ?? '')) lat = 'c';
    out += ch !== lower && lat.length > 0 ? lat[0]!.toUpperCase() + lat.slice(1) : lat;
  }
  return out;
}

/** Латинские буквы без разложения в NFD. */
const LATIN_EXTRA: Readonly<Record<string, string>> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', þ: 'th', ı: 'i' };

/**
 * Свёртка вариантов романизации: «Tsoi»/«Czoj», «Khleb»/«Xleb», «Gruppa»/«Grupa»
 * дают одно и то же. Применяется к обеим сторонам сравнения, поэтому искажение английских слов не мешает.
 */
function foldLatin(text: string): string {
  return text
    .replace(/shch|sch|shh/g, 'sh')
    .replace(/kh|x/g, 'h')
    .replace(/cz|tz|ts/g, 'c')
    .replace(/[jy]/g, 'i')
    .replace(/([a-z])\1+/g, '$1');
}

/** NFKC, нижний регистр, ё→е, транслитерация, без диакритики и пунктуации. */
export function normalizeText(text: string): string {
  const base = text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
  // Кириллицу переводим до снятия диакритики: иначе NFD превратит «й» в «и».
  const latin = transliterate(base)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[øæœßłđþı]/g, (c) => LATIN_EXTRA[c] ?? c);
  return foldLatin(latin.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).replace(/\s+/g, ' ');
}

export function hasCyrillic(text: string): boolean {
  return /\p{Script=Cyrillic}/u.test(text);
}

// ─── разбор названия ─────────────────────────────────────────────────────────

const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';
const word = (body: string) => new RegExp(`${WORD_START}(?:${body})${WORD_END}`, 'iu');

/** Версии, которые нельзя сливать с оригиналом. */
const VERSION_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
  ['remix', word('re-?mix|rmx|ремикс|bootleg|бутлег')],
  ['live', word('live|концерт\\p{L}*|живьём|живьем|живое исполнение')],
  ['acoustic', word('acoustic|unplugged|акустик\\p{L}*')],
  ['instrumental', word('instrumental|инструментал\\p{L}*|минус|karaoke|караоке')],
  ['sped up', word('sped up|speed up|spedup|nightcore|спид ап')],
];

/** Скобки/хвосты, которые ничего не говорят о записи. */
const NOISE = word(
  'official|video|audio|lyrics?|visuali[sz]er|clip|клип|премьера|official music video|hd|hq|4k|mv|' +
    'remaster(?:ed)?|ремастер\\p{L}*|mono|stereo|explicit|clean|radio edit|original mix|' +
    'feat\\.?|ft\\.?|featuring|при уч\\.?|при участии|prod\\.?|официальн\\p{L}*',
);

const FEAT_TAIL = /\s+(?:feat\.?|ft\.?|featuring|при уч\.?|при участии)\s.*$/iu;
const SEPARATOR = /\s+[-–—]{1,2}\s+|\s+\|\s+/u;

export interface ParsedTitle {
  base: string;
  version: string;
}

/** Базовое название без мусора и версия (remix, live…), чтобы разные версии не слились. */
export function parseTitle(title: string): ParsedTitle {
  const versions = new Set<string>();
  const collect = (fragment: string) => {
    for (const [token, re] of VERSION_TOKENS) if (re.test(fragment)) versions.add(token);
  };

  let base = title.normalize('NFKC').replace(/[([{]([^()[\]{}]*)[)\]}]/gu, (whole, inner: string) => {
    collect(inner);
    const isVersion = VERSION_TOKENS.some(([, re]) => re.test(inner));
    return isVersion || NOISE.test(inner) ? ' ' : whole;
  });

  // Хвосты вида « - Remastered 2009», « - Live at Wembley».
  const parts = base.split(SEPARATOR);
  if (parts.length > 1) {
    const kept = [parts[0] as string];
    for (const part of parts.slice(1)) {
      const before = versions.size;
      collect(part);
      if (versions.size > before || NOISE.test(part)) continue;
      kept.push(part);
    }
    base = kept.join(' - ');
  }

  base = base.replace(FEAT_TAIL, '').replace(/\s+/g, ' ').trim();
  return { base: base || title.trim(), version: [...versions].sort().join('+') };
}

/** «Артист - Название» внутри названия. */
export function splitArtistTitle(title: string): { artist: string; title: string } | null {
  const m = SEPARATOR.exec(title);
  if (!m || m.index === 0) return null;
  const artist = title.slice(0, m.index).trim();
  const rest = title.slice(m.index + m[0].length).trim();
  if (!artist || !rest) return null;
  return { artist, title: rest };
}

/** Первый исполнитель из «A & B», «A, B», «A x B», «A feat. B». */
export function firstArtist(artist: string): string {
  const [first] = artist.split(/\s*(?:&|,|;|\s+x\s+|\s+(?:feat\.?|ft\.?|featuring|при уч\.?|при участии)\s+)\s*/iu);
  return (first ?? artist).trim() || artist.trim();
}

/** Одно и то же имя: совпадение после нормализации или вхождение целым словом («Verukka» в «Verukka salt»). */
export function sameArtist(a: string, b: string): boolean {
  const x = normalizeText(firstArtist(a));
  const y = normalizeText(firstArtist(b));
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && ` ${long} `.includes(` ${short} `);
}

const GENERIC_ARTISTS = new Set(['various', 'various artists', 'va', 'unknown', 'unknown artist', 'сборник', 'разные исполнители']);

export interface DedupInput {
  artist: string;
  title: string;
}

/** Ключ дедупликации: первый артист | базовое название | версия. Длительность сравнивается отдельно (±3 с). */
export function dedupKey(track: DedupInput): string {
  let artist = track.artist;
  let title = track.title;
  const split = splitArtistTitle(title);
  if (split) {
    if (sameArtist(split.artist, artist)) title = split.title;
    else if (GENERIC_ARTISTS.has(normalizeText(artist))) {
      artist = split.artist;
      title = split.title;
    }
  }
  const { base, version } = parseTitle(title);
  return `${normalizeText(firstArtist(artist))}|${normalizeText(base)}|${version}`;
}

export const DURATION_TOLERANCE_SEC = 3;

export function sameDuration(a: number, b: number): boolean {
  // Нулевая длительность — источник её не знает: сравнивать не с чем.
  if (a <= 0 || b <= 0) return true;
  return Math.abs(a - b) <= DURATION_TOLERANCE_SEC;
}

// ─── слияние источников ─────────────────────────────────────────────────────

/** Треки Audius от проверенных авторов. Отдельно от `Track`: контракт API это поле не несёт. */
const verifiedAudius = new WeakSet<Track>();

export function markVerified(track: Track): Track {
  verifiedAudius.add(track);
  return track;
}

export function isVerified(track: Track): boolean {
  return verifiedAudius.has(track);
}

const PROVIDER_RANK: Readonly<Record<string, number>> = { audius: 0, jamendo: 1, archive: 2, commons: 3 };

/** Меньше — лучше: полный трек, затем проверенный Audius, Jamendo, IA, Commons, непроверенный Audius. */
export function sourceRank(track: Track): number {
  const playback = track.playback === 'full' ? 0 : track.playback === 'preview' ? 10 : 20;
  const provider =
    track.provider === 'audius' ? (isVerified(track) ? 0 : 4) : (PROVIDER_RANK[track.provider] ?? 5);
  return playback + provider;
}

interface Group {
  key: string;
  members: Track[];
}

/**
 * Склеивает один и тот же трек из разных источников: сначала по ISRC,
 * затем по нормализованному ключу с допуском длительности ±3 с. Порядок — по первому появлению.
 */
export function mergeTracks(tracks: readonly Track[]): Track[] {
  const groups: Group[] = [];
  const byKey = new Map<string, Group[]>();
  const byIsrc = new Map<string, Group>();
  const seenIds = new Set<string>();

  for (const track of tracks) {
    if (seenIds.has(track.id)) continue;
    seenIds.add(track.id);
    const isrc = track.isrc?.trim().toUpperCase() || null;
    let group = isrc ? byIsrc.get(isrc) : undefined;
    const key = dedupKey(track);
    if (!group) {
      group = byKey.get(key)?.find((g) => g.members.some((m) => sameDuration(m.durationSec, track.durationSec)));
    }
    if (!group) {
      group = { key, members: [] };
      groups.push(group);
      byKey.set(key, [...(byKey.get(key) ?? []), group]);
    }
    group.members.push(track);
    if (isrc && !byIsrc.has(isrc)) byIsrc.set(isrc, group);
  }

  return groups.map(({ members }) => {
    const sorted = [...members].sort((a, b) => sourceRank(a) - sourceRank(b));
    const winner = sorted[0] as Track;
    if (sorted.length === 1) return winner;
    const artworkUrl = winner.artworkUrl ?? sorted.find((t) => t.artworkUrl)?.artworkUrl ?? null;
    const isrc = winner.isrc ?? sorted.find((t) => t.isrc)?.isrc ?? null;
    if (artworkUrl === winner.artworkUrl && isrc === winner.isrc) return winner;
    const merged: Track = { ...winner, artworkUrl, isrc };
    if (isVerified(winner)) markVerified(merged);
    return merged;
  });
}

/** Поочерёдно из каждого списка: витрина не должна целиком состоять из одного источника. */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

/** Фильтр языка для источников без поля языка: по наличию кириллицы в названии или имени. */
export function matchesLanguage(track: Pick<Track, 'title' | 'artist'>, language: 'ru' | 'foreign' | null | undefined): boolean {
  if (!language) return true;
  const cyr = hasCyrillic(track.title) || hasCyrillic(track.artist);
  return language === 'ru' ? cyr : !cyr;
}

/** Идентификатор трека: [A-Za-z0-9._\-/]{1,160} после префикса. */
export const TRACK_REF_RE = /^[A-Za-z0-9._\-/]{1,160}$/;

/**
 * Имя файла → часть id. Имя из допустимых символов идёт как есть (читаемые id),
 * остальное — обратимо в base64url с префиксом «b64.»; не влезло в длину — null (трек пропускается).
 */
export function encodeRef(name: string, maxLength = 160): string | null {
  if (!name.startsWith('b64.') && TRACK_REF_RE.test(name) && name.length <= maxLength) return name;
  const encoded = `b64.${Buffer.from(name, 'utf8').toString('base64url')}`;
  return encoded.length <= maxLength ? encoded : null;
}

/** Обратное к `encodeRef`. */
export function decodeRef(ref: string): string | null {
  if (!ref.startsWith('b64.')) return ref;
  try {
    const decoded = Buffer.from(ref.slice(4), 'base64url').toString('utf8');
    return decoded || null;
  } catch {
    return null;
  }
}
