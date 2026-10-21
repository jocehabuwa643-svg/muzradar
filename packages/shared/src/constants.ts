/** Жанры, из которых пользователь собирает вкус на онбординге. */
export const GENRES = [
  { id: 'pop', label: 'Поп' },
  { id: 'hiphop', label: 'Хип-хоп' },
  { id: 'rock', label: 'Рок' },
  { id: 'russian_rock', label: 'Русский рок' },
  { id: 'indie', label: 'Инди' },
  { id: 'electronic', label: 'Электроника' },
  { id: 'house', label: 'Хаус' },
  { id: 'techno', label: 'Техно' },
  { id: 'dnb', label: 'Драм-н-бейс' },
  { id: 'phonk', label: 'Фонк' },
  { id: 'trap', label: 'Трэп' },
  { id: 'rnb', label: 'R&B' },
  { id: 'jazz', label: 'Джаз' },
  { id: 'blues', label: 'Блюз' },
  { id: 'classical', label: 'Классика' },
  { id: 'soundtrack', label: 'Саундтреки' },
  { id: 'metal', label: 'Метал' },
  { id: 'punk', label: 'Панк' },
  { id: 'folk', label: 'Фолк' },
  { id: 'reggae', label: 'Регги' },
  { id: 'latin', label: 'Латина' },
  { id: 'kpop', label: 'K-pop' },
  { id: 'lofi', label: 'Lo-fi' },
  { id: 'ambient', label: 'Эмбиент' },
  { id: 'estrada', label: 'Эстрада' },
  { id: 'chanson', label: 'Шансон' },
] as const;

export type GenreId = (typeof GENRES)[number]['id'];
export const GENRE_IDS = GENRES.map((g) => g.id) as [GenreId, ...GenreId[]];

/** Настроения — они же сценарии для AI-поиска и раздела «По настроению». */
export const MOODS = [
  { id: 'sport', label: 'Спорт', emoji: '🏃' },
  { id: 'drive', label: 'В машине', emoji: '🚗' },
  { id: 'night', label: 'Ночь', emoji: '🌙' },
  { id: 'work', label: 'Работа', emoji: '💼' },
  { id: 'focus', label: 'Фокус', emoji: '🎯' },
  { id: 'chill', label: 'Чилл', emoji: '🌊' },
  { id: 'party', label: 'Вечеринка', emoji: '🎉' },
  { id: 'romance', label: 'Романтика', emoji: '💜' },
  { id: 'sad', label: 'Грусть', emoji: '🌧' },
  { id: 'morning', label: 'Утро', emoji: '☀️' },
] as const;

export type MoodId = (typeof MOODS)[number]['id'];
export const MOOD_IDS = MOODS.map((m) => m.id) as [MoodId, ...MoodId[]];

/** Разделы музыкальной витрины. */
export const SECTION_IDS = [
  'for_you',
  'new',
  'popular',
  'classics',
  'russian',
  'foreign',
  'underground',
  'moods',
  'nearby',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const LIMITS = {
  nameMin: 2,
  nameMax: 24,
  minAge: 16,
  /** Младше этого возраста — видимость только для взаимных подписок. */
  adultAge: 18,
  tasteGenresMin: 3,
  tasteGenresMax: 12,
  tasteMoodsMin: 1,
  tasteArtistsMin: 1,
  tasteArtistsMax: 30,
  /** 128×128 WebP q0.6 ≈ 1.5 КБ → ~2 КБ base64; запас на шумные снимки. */
  avatarBase64Max: 16_000,
  avatarSide: 128,
  mapAvatarSide: 96,
} as const;

/**
 * Точность geohash.
 * Клиент никогда не отправляет координаты — только ячейку `client` (~150 м).
 * Сервер показывает незнакомцам ячейку `public` (~1.2×0.6 км) со стабильным смещением.
 */
export const GEO_PRECISION = {
  client: 7,
  public: 6,
  followers: 7,
  /** Комнаты реалтайма: ~4.9×4.9 км и ~39×19.5 км. */
  roomFine: 5,
  roomCoarse: 4,
} as const;

export const PRESENCE = {
  /** Точка живёт столько без обновлений и heartbeat, потом исчезает с карты. */
  ttlSec: 120,
  /** Пока в фоне играет музыка, heartbeat продлевает последнюю ячейку — но не дольше этого. */
  hardTtlSec: 8 * 60 * 60,
  /** Клиент шлёт обновление позиции/трека не чаще. */
  minIntervalMs: 5_000,
  heartbeatMs: 45_000,
  /** Сервер копит изменения по комнате и рассылает пачкой. */
  batchMs: 1_000,
  /** Живой режим (отдельные точки) — с этого зума; ниже — кластеры. */
  liveMinZoom: 12,
  /** Максимум комнат на одно подключение. */
  maxRooms: 24,
  /** Максимум точек в снимке вьюпорта. */
  snapshotLimit: 300,
} as const;

/** Гистерезис смены ячейки на устройстве: дрожание GPS у границы не выдаёт границу. */
export const CELL_HYSTERESIS = {
  /** Фиксы хуже этой точности игнорируются. */
  maxAccuracyM: 150,
  /** Первый фикс принимается с точностью не хуже. */
  firstFixMaxAccuracyM: 500,
  /** Переход в соседнюю публичную ячейку — только если зашли вглубь на столько. */
  publicSwitchDepthM: 75,
  /** Переход между мелкими ячейками внутри той же публичной. */
  fineSwitchDepthM: 20,
  /**
   * Приблизительная геолокация (Android «Приблизительно», iOS без «Точной геопозиции»): фиксы обычно 1–3 км,
   * у iOS бывает и хуже. Порог общий для первого и следующих фиксов — отбрасываем только совсем грубое,
   * иначе такой пользователь снова пропадёт с карты.
   */
  approxMaxAccuracyM: 10_000,
  /** Грубая точка у края квартала прыгает туда-сюда: переходим в соседний, только зайдя на столько вглубь. */
  approxSwitchDepthM: 200,
} as const;

/** Версии юридических документов; меняются вместе с текстами на сайте. */
export const LEGAL_VERSIONS = {
  processing: '2026-09-15',
  dissemination: '2026-09-15',
  rules: '2026-09-15',
} as const;

export const API_PREFIX = '/v1';
