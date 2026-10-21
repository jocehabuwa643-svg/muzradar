const MINUTE = 60_000;

/**
 * Сроки жизни кэша. Кэшируются только метаданные, аудио — никогда.
 * Audius разрешает лишь «сессионный» кэш: потолок 24 ч, фактически держим меньше.
 */
export const CACHE_TTL = {
  audiusMetaMaxMs: 24 * 60 * MINUTE,
  sectionsMs: 10 * MINUTE,
  /** Витрина, где какой-то источник не ответил: пересобираем скоро, иначе пустое «На русском» висело бы 10 минут. */
  sectionsPartialMs: 2 * MINUTE,
  searchMs: 5 * MINUTE,
  resolveMs: 10 * MINUTE,
  /** Отсутствующий трек помним недолго: мог появиться, а повторные запросы не должны бить в источник. */
  resolveMissMs: MINUTE,
  /** Метаданные элемента IA (CC/PD) меняются редко, условия разрешают хранение. */
  archiveItemMs: 6 * 60 * MINUTE,
  /** Похожие артисты (MusicBrainz/ListenBrainz, CC0) меняются редко; «не нашли» перепроверяем через час. */
  similarArtistsMs: 24 * 60 * MINUTE,
  similarArtistsMissMs: 60 * MINUTE,
} as const;

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** LRU с TTL в памяти процесса; одинаковые одновременные промахи сливаются в один запрос. */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { max: number; now?: () => number }) {
    this.max = opts.max;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Переставляем в конец: Map хранит порядок вставки, начало — самые давние.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Значение из кэша или результат `load`; ошибки не кэшируются. `ttl` может зависеть от значения. */
  async wrap(key: string, ttl: number | ((value: V) => number), load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = load().then(
      (value) => {
        this.inflight.delete(key);
        this.set(key, value, typeof ttl === 'function' ? ttl(value) : ttl);
        return value;
      },
      (err: unknown) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }
}
