import { PRESENCE, type BBox, type ClusterCell } from '@muzradar/shared';
import type { Redis } from 'ioredis';
import { randomId } from '../../ids.ts';
import { byDistanceToCenter, groupClusters, inBBox, isExpired } from './memory.ts';
import type { HeartbeatPatch, PresenceRecord, PresenceStore } from './store.ts';

/** GEOADD не принимает широты за пределами проекции Меркатора. */
const MAX_LAT = 85.05112878;
/** Радиус Земли, которым считает Redis (geohash_helper.c), → км на градус дуги. */
const REDIS_KM_PER_DEG = (6372.797560856 * Math.PI) / 180;
const DEG = Math.PI / 180;
/**
 * JSON живёт дольше TTL точки: чистильщик должен успеть прочитать запись,
 * чтобы разослать удаление в её комнату. EXPIRE — страховка, если чистильщик не работает.
 */
const RECORD_TTL_SEC = PRESENCE.ttlSec + 60;
/** По 250 из каждого ZSET → не больше 500 id в unpack() (лимит стека Lua). */
const SWEEP_BATCH = 250;
const SWEEP_ROUNDS = 8;
const LOCK_TTL_MS = 4_500;
/** Потолок точек для кластеров, пока нет агрегатов по ячейкам (фаза 1: счётчики у лидера). */
const CLUSTER_SCAN_CAP = 20_000;

// KEYS: seen, pos, geo. ARGV: граница seenAt, граница positionAt (обе строгие), размер пачки.
const SWEEP_LUA = `
local limit = tonumber(ARGV[3])
local ids = redis.call('ZRANGE', KEYS[1], '-inf', '(' .. ARGV[1], 'BYSCORE', 'LIMIT', 0, limit)
local stale = redis.call('ZRANGE', KEYS[2], '-inf', '(' .. ARGV[2], 'BYSCORE', 'LIMIT', 0, limit)
local seen = {}
for _, id in ipairs(ids) do seen[id] = true end
for _, id in ipairs(stale) do
  if not seen[id] then
    seen[id] = true
    ids[#ids + 1] = id
  end
end
if #ids == 0 then return {} end
redis.call('ZREM', KEYS[1], unpack(ids))
redis.call('ZREM', KEYS[2], unpack(ids))
redis.call('ZREM', KEYS[3], unpack(ids))
return ids
`;

// KEYS[1] = seen, KEYS[2..] = записи; ARGV[i] = id для KEYS[i + 1].
// Кто успел вернуться между двумя скриптами (снова есть в seen), тот не трогается.
const TAKE_LUA = `
local out = {}
for i = 2, #KEYS do
  local v = false
  if not redis.call('ZSCORE', KEYS[1], ARGV[i - 1]) then
    v = redis.call('GET', KEYS[i])
    if v then redis.call('DEL', KEYS[i]) end
  end
  out[#out + 1] = v or ''
end
return out
`;

interface SweepCommands {
  presSweep(seen: string, pos: string, geo: string, seenCutoff: number, posCutoff: number, limit: number): Promise<string[]>;
  presTake(numKeys: number, ...keysAndArgs: string[]): Promise<string[]>;
}

export interface RedisPresenceOptions {
  /** Префикс ключей с хеш-тегом: все ключи в одном слоте Redis Cluster. */
  prefix?: string;
  /** Метка ноды для лидер-лока чистильщика. */
  nodeId?: string;
}

/**
 * Присутствие в Redis: GEO точек отображения + ZSET seenAt/positionAt + JSON записи.
 * У членов GEO нет своего TTL, поэтому истечение — это чистильщик на Lua.
 * Соединение принадлежит вызывающему: close() его не закрывает.
 */
export class RedisPresenceStore implements PresenceStore {
  readonly kind = 'redis' as const;
  private readonly keys: { geo: string; seen: string; pos: string; lock: string; u: (id: string) => string };
  private readonly nodeId: string;
  private readonly cmd: Redis & SweepCommands;
  private readonly redis: Redis;

  constructor(redis: Redis, opts: RedisPresenceOptions = {}) {
    this.redis = redis;
    const p = opts.prefix ?? 'mr:{pres}';
    this.keys = {
      geo: `${p}:geo`,
      seen: `${p}:seen`,
      pos: `${p}:pos`,
      lock: `${p}:sweep:lock`,
      u: (id) => `${p}:u:${id}`,
    };
    this.nodeId = opts.nodeId ?? randomId(12);
    redis.defineCommand('presSweep', { numberOfKeys: 3, lua: SWEEP_LUA });
    // без numberOfKeys первым аргументом идёт число ключей: их количество переменное
    redis.defineCommand('presTake', { lua: TAKE_LUA });
    this.cmd = redis as Redis & SweepCommands;
  }

  async get(userId: string): Promise<PresenceRecord | null> {
    return parseRecord(await this.redis.get(this.keys.u(userId)));
  }

  async upsert(record: PresenceRecord): Promise<void> {
    await this.write(record);
  }

  async heartbeat(userId: string, patch: HeartbeatPatch, now: number): Promise<PresenceRecord | null> {
    const current = await this.get(userId);
    if (!current || isExpired(current, now)) return null;
    const next: PresenceRecord = { ...current, track: patch.track, playing: patch.playing, positionSec: patch.positionSec, seenAt: now };
    // полная запись, а не только ZADD: если чистильщик успел убрать точку из GEO, она вернётся
    await this.write(next);
    return next;
  }

  async remove(userId: string): Promise<PresenceRecord | null> {
    const current = await this.get(userId);
    const k = this.keys;
    checkExec(
      await this.redis.multi().zrem(k.geo, userId).zrem(k.seen, userId).zrem(k.pos, userId).del(k.u(userId)).exec(),
    );
    return current;
  }

  async searchBBox(bbox: BBox, limit: number): Promise<PresenceRecord[]> {
    if (limit <= 0) return [];
    // GEOSEARCH отбирает с запасом, точный bbox — по JSON (Redis хранит 52-битный geohash)
    const ids = await this.searchIds(bbox, limit * 2 + 20);
    const records = await this.load(ids);
    return records.filter((r) => inBBox(r, bbox)).sort(byDistanceToCenter(bbox)).slice(0, limit);
  }

  async clusters(bbox: BBox, precision: number, limit: number): Promise<ClusterCell[]> {
    const ids = await this.searchIds(bbox, CLUSTER_SCAN_CAP);
    const records = await this.load(ids);
    return groupClusters(
      records.filter((r) => inBBox(r, bbox)),
      precision,
      limit,
    );
  }

  async sweep(now: number): Promise<PresenceRecord[]> {
    if (!(await this.acquireLock())) return [];
    const k = this.keys;
    const seenCutoff = now - PRESENCE.ttlSec * 1000;
    const posCutoff = now - PRESENCE.hardTtlSec * 1000;
    const removed: PresenceRecord[] = [];
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const ids = await this.cmd.presSweep(k.seen, k.pos, k.geo, seenCutoff, posCutoff, SWEEP_BATCH);
      if (ids.length === 0) break;
      const raw = await this.cmd.presTake(ids.length + 1, k.seen, ...ids.map(k.u), ...ids);
      for (const v of raw) {
        const r = parseRecord(v || null);
        if (r) removed.push(r);
      }
      if (ids.length < SWEEP_BATCH) break;
    }
    return removed;
  }

  async close(): Promise<void> {
    // соединение общее (лимиты, адаптер) — закрывает его владелец
  }

  private async write(record: PresenceRecord): Promise<void> {
    const k = this.keys;
    const lat = Math.min(MAX_LAT, Math.max(-MAX_LAT, record.lat));
    checkExec(
      await this.redis
        .multi()
        .geoadd(k.geo, record.lng, lat, record.userId)
        .zadd(k.seen, record.seenAt, record.userId)
        .zadd(k.pos, record.positionAt, record.userId)
        .set(k.u(record.userId), JSON.stringify(record), 'EX', RECORD_TTL_SEC)
        .exec(),
    );
  }

  private async searchIds([w, s, e, n]: BBox, count: number): Promise<string[]> {
    const clampLat = (v: number) => Math.min(MAX_LAT, Math.max(-MAX_LAT, v));
    const cLng = (w + e) / 2;
    const cLat = clampLat((s + n) / 2);
    // ширину берём по самой «широкой» параллели bbox: на остальных коробка захватит больше
    const nearestToEquator = s <= 0 && n >= 0 ? 0 : Math.min(Math.abs(s), Math.abs(n));
    const widthKm = (e - w) * REDIS_KM_PER_DEG * Math.cos(nearestToEquator * DEG) * 1.02 + 0.05;
    const heightKm = (clampLat(n) - clampLat(s)) * REDIS_KM_PER_DEG * 1.02 + 0.05;
    const ids = await this.redis.geosearch(
      this.keys.geo,
      'FROMLONLAT',
      cLng,
      cLat,
      'BYBOX',
      widthKm.toFixed(3),
      heightKm.toFixed(3),
      'km',
      'ASC',
      'COUNT',
      count,
    );
    return ids.filter((v): v is string => typeof v === 'string');
  }

  private async load(ids: string[]): Promise<PresenceRecord[]> {
    if (ids.length === 0) return [];
    const out: PresenceRecord[] = [];
    // MGET в одном слоте: у всех ключей общий хеш-тег
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const values = await this.redis.mget(...chunk.map(this.keys.u));
      for (const v of values) {
        // запись без JSON (EXPIRE сработал раньше чистильщика) просто пропускаем
        const r = parseRecord(v);
        if (r) out.push(r);
      }
    }
    return out;
  }

  private async acquireLock(): Promise<boolean> {
    const k = this.keys.lock;
    if ((await this.redis.set(k, this.nodeId, 'PX', LOCK_TTL_MS, 'NX')) === 'OK') return true;
    // лок уже наш (повторный вызов в пределах тика) — продолжаем
    return (await this.redis.get(k)) === this.nodeId;
  }
}

function parseRecord(raw: string | null): PresenceRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PresenceRecord;
  } catch {
    return null;
  }
}

function checkExec(result: [error: Error | null, result: unknown][] | null): void {
  if (!result) throw new Error('redis transaction aborted');
  for (const [err] of result) if (err) throw err;
}
