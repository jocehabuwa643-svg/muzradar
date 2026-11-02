import { z } from 'zod';
import { GENRE_IDS, LIMITS, MOOD_IDS, SECTION_IDS } from './constants.ts';
import { GEOHASH_RE } from './geo.ts';

// ─── общие ───────────────────────────────────────────────────────────────────

export const UserId = z.string().regex(/^u_[0-9a-z]{20}$/, 'bad user id');
export type UserId = z.infer<typeof UserId>;

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/** Имя: буквы любых алфавитов, цифры, пробел и `-_.`; без ссылок. */
export const DisplayName = z
  .string()
  .trim()
  .min(LIMITS.nameMin, `Минимум ${LIMITS.nameMin} символа`)
  .max(LIMITS.nameMax, `Максимум ${LIMITS.nameMax} символа`)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, 'Только буквы, цифры, пробел и - _ .')
  .refine((v) => !/(https?:|www\.|\.(ru|com|net|org|рф)\b)/iu.test(v), 'Ссылки в имени запрещены');

export function birthYearBounds(now = new Date()) {
  const year = now.getUTCFullYear();
  return { min: year - 100, max: year - LIMITS.minAge };
}

// ─── аутентификация устройства ───────────────────────────────────────────────

export const Platform = z.enum(['ios', 'android', 'web']);
export type Platform = z.infer<typeof Platform>;

/**
 * installSecret — 32 случайных байта в base64url, живёт в Keychain/Keystore.
 * deviceHint — Android ID (SSAID, привязан к ключу подписи): только для восстановления
 * после переустановки на Android. IP в опознании не участвует.
 */
export const DeviceAuthRequest = z.object({
  installSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'bad install secret'),
  deviceHint: z
    .string()
    .regex(/^[0-9a-f]{16}$/i)
    .optional(),
  platform: Platform,
  appVersion: z.string().max(32),
});
export type DeviceAuthRequest = z.infer<typeof DeviceAuthRequest>;

// ─── профиль ─────────────────────────────────────────────────────────────────

export const Taste = z.object({
  genres: z.array(z.enum(GENRE_IDS)).min(LIMITS.tasteGenresMin).max(LIMITS.tasteGenresMax),
  moods: z.array(z.enum(MOOD_IDS)).min(LIMITS.tasteMoodsMin),
  artists: z.array(z.string().trim().min(1).max(80)).min(LIMITS.tasteArtistsMin).max(LIMITS.tasteArtistsMax),
});
export type Taste = z.infer<typeof Taste>;

export const DisseminationScope = z.enum(['name', 'avatar', 'track', 'location']);
export type DisseminationScope = z.infer<typeof DisseminationScope>;

export const Consents = z.object({
  processing: z.object({ version: z.string(), acceptedAt: z.iso.datetime() }),
  dissemination: z.object({
    version: z.string(),
    acceptedAt: z.iso.datetime(),
    scope: z.array(DisseminationScope).min(1),
  }),
  rules: z.object({ version: z.string(), acceptedAt: z.iso.datetime() }),
});
export type Consents = z.infer<typeof Consents>;

export const Visibility = z.enum(['public', 'followers', 'ghost']);
export type Visibility = z.infer<typeof Visibility>;

/** Шаг «Согласия и возраст»: сразу после регистрации устройства. */
export const ConsentsInput = z.object({
  birthYear: z.int(),
  consents: Consents,
});
export type ConsentsInput = z.infer<typeof ConsentsInput>;

/** Завершение онбординга: имя и вкус (аватар к этому моменту уже загружен). */
export const ProfileInput = z.object({
  name: DisplayName,
  taste: Taste,
});
export type ProfileInput = z.infer<typeof ProfileInput>;

export const Me = z.object({
  id: UserId,
  name: z.string().nullable(),
  birthYear: z.int().nullable(),
  avatarUrl: z.string().nullable(),
  mapAvatarUrl: z.string().nullable(),
  taste: Taste.nullable(),
  visibility: Visibility,
  /** Версия принятого согласия на обработку; null — шаг согласий не пройден. */
  consentsVersion: z.string().nullable(),
  onboardedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Me = z.infer<typeof Me>;

export const SessionResponse = z.object({
  accessToken: z.string(),
  expiresInSec: z.int().positive(),
  me: Me,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const DeviceAuthResponse = z.object({
  accessToken: z.string(),
  expiresInSec: z.int().positive(),
  isNew: z.boolean(),
  /** Аккаунт найден по deviceHint после переустановки и привязан к новому секрету. */
  restored: z.boolean(),
  me: Me,
});
export type DeviceAuthResponse = z.infer<typeof DeviceAuthResponse>;

export const AvatarUploadRequest = z.object({
  imageBase64: z.base64().max(LIMITS.avatarBase64Max),
});
export type AvatarUploadRequest = z.infer<typeof AvatarUploadRequest>;

export const AvatarUploadResponse = z.object({
  avatarUrl: z.string(),
  mapAvatarUrl: z.string(),
  bytes: z.int().positive(),
});
export type AvatarUploadResponse = z.infer<typeof AvatarUploadResponse>;

// ─── музыка ──────────────────────────────────────────────────────────────────

export const ProviderId = z.enum(['audius', 'jamendo', 'archive', 'commons', 'deezer', 'itunes']);
export type ProviderId = z.infer<typeof ProviderId>;

/** full — весь трек; preview — отрывок; unavailable — нельзя играть (скрывается из выдачи). */
export const Playback = z.enum(['full', 'preview', 'unavailable']);
export type Playback = z.infer<typeof Playback>;

export const TrackId = z.string().regex(/^[a-z]+:[A-Za-z0-9._\-/]{1,160}$/, 'bad track id');
export type TrackId = z.infer<typeof TrackId>;

export const Track = z.object({
  id: TrackId,
  provider: ProviderId,
  title: z.string(),
  artist: z.string(),
  album: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  durationSec: z.number().nonnegative(),
  playback: Playback,
  /** Длина отрывка, если playback = preview. */
  previewSec: z.number().positive().nullable(),
  genres: z.array(z.string()),
  isrc: z.string().nullable(),
  /** Ссылка на лицензию/условия источника, если есть (CC BY и т. п.). */
  licenseUrl: z.string().nullable(),
  /** Прямая ссылка для плеера. Может истекать — перед воспроизведением берётся свежая. */
  streamUrl: z.string().nullable(),
  /** Страница трека у источника: атрибуция по OML (Audius) и обязательная обратная ссылка Jamendo. */
  pageUrl: z.string().nullish(),
});
export type Track = z.infer<typeof Track>;

/** То, что видно о треке другим на карте. */
export const TrackRef = Track.pick({
  id: true,
  title: true,
  artist: true,
  artworkUrl: true,
  playback: true,
});
export type TrackRef = z.infer<typeof TrackRef>;

export const Section = z.object({
  id: z.enum(SECTION_IDS),
  title: z.string(),
  subtitle: z.string().nullable(),
  tracks: z.array(Track),
  /**
   * Честная пометка, если раздел пустой или неполный («Источник временно недоступен»).
   * Раздел с пометкой показывается даже без треков — он не должен молча исчезать.
   */
  notice: z.string().nullish(),
});
export type Section = z.infer<typeof Section>;

export const SectionsResponse = z.object({ sections: z.array(Section) });
export type SectionsResponse = z.infer<typeof SectionsResponse>;

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const TracksResponse = z.object({ tracks: z.array(Track) });
export type TracksResponse = z.infer<typeof TracksResponse>;

export const ArtistSuggestion = z.object({
  name: z.string(),
  imageUrl: z.string().nullable(),
  genres: z.array(z.string()),
});
export type ArtistSuggestion = z.infer<typeof ArtistSuggestion>;

export const ArtistSuggestionsResponse = z.object({ artists: z.array(ArtistSuggestion) });
export type ArtistSuggestionsResponse = z.infer<typeof ArtistSuggestionsResponse>;

// ─── присутствие на карте ────────────────────────────────────────────────────

export const Geohash = z.string().regex(GEOHASH_RE, 'bad geohash');
export const MotionSchema = z.enum(['still', 'walk', 'drive']);

/** Клиент → сервер. Никаких координат: только ячейка точности GEO_PRECISION.client. */
export const PresenceUpdate = z.object({
  cell: Geohash.length(7),
  motion: MotionSchema,
  /** Пользователь выдал только приблизительную геолокацию. */
  approx: z.boolean(),
  track: TrackRef.nullable(),
  playing: z.boolean(),
  positionSec: z.number().nonnegative().nullable(),
});
export type PresenceUpdate = z.infer<typeof PresenceUpdate>;

/** Heartbeat из фона: трек меняется, позиция — нет. */
export const PresenceHeartbeat = PresenceUpdate.pick({ track: true, playing: true, positionSec: true });
export type PresenceHeartbeat = z.infer<typeof PresenceHeartbeat>;

/** Сервер → клиент: то, что видно о слушателе на карте. */
export const PresenceView = z.object({
  userId: UserId,
  name: z.string(),
  mapAvatarUrl: z.string().nullable(),
  /** Уже размытая позиция: центр ячейки + стабильное смещение. */
  lng: z.number(),
  lat: z.number(),
  /** Точность geohash, с которой показана точка. */
  precision: z.int().min(1).max(12),
  /**
   * Пользователь выдал только приблизительную геолокацию: рисовать квартал вокруг точки, а не пин.
   * Нет поля (старый сервер) — считать точным.
   */
  approx: z.boolean().optional(),
  motion: MotionSchema,
  track: TrackRef.nullable(),
  playing: z.boolean(),
  positionSec: z.number().nonnegative().nullable(),
  updatedAt: z.int(),
});
export type PresenceView = z.infer<typeof PresenceView>;

export const BBoxSchema = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .refine(([w, s, e, n]) => w <= e && s <= n, 'bad bbox');

export const Viewport = z.object({
  bbox: BBoxSchema,
  zoom: z.number().min(0).max(24),
});
export type Viewport = z.infer<typeof Viewport>;

export const NearbyResponse = z.object({ users: z.array(PresenceView) });
export type NearbyResponse = z.infer<typeof NearbyResponse>;

/** HTTP-запрос вьюпорта: bbox строкой `w,s,e,n`. */
export const ViewportQuery = z.object({
  bbox: z
    .string()
    .transform((v, ctx) => {
      const parts = v.split(',').map(Number);
      const parsed = BBoxSchema.safeParse(parts);
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'bbox must be "w,s,e,n"' });
        return z.NEVER;
      }
      return parsed.data;
    }),
  zoom: z.coerce.number().min(0).max(24),
});
export type ViewportQuery = z.infer<typeof ViewportQuery>;

/** Мелкий зум: вместо точек — количество слушателей по ячейкам. */
export const ClusterCell = z.object({
  cell: Geohash,
  count: z.int().positive(),
  lng: z.number(),
  lat: z.number(),
});
export type ClusterCell = z.infer<typeof ClusterCell>;

export const ClustersResponse = z.object({
  precision: z.int().min(1).max(12),
  cells: z.array(ClusterCell),
});
export type ClustersResponse = z.infer<typeof ClustersResponse>;

/** Что сейчас играет у слушателя — для «слушать вместе». */
export const ListenState = z.object({
  userId: UserId,
  /** Полный трек со ссылкой на поток клиент берёт сам: GET /v1/catalog/tracks/:id. */
  track: TrackRef.nullable(),
  playing: z.boolean(),
  positionSec: z.number().nonnegative().nullable(),
  /** Серверное время снимка, мс — для компенсации задержки. */
  at: z.int(),
});
export type ListenState = z.infer<typeof ListenState>;
