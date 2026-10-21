import { PRESENCE, decodeGeohashBBox, encodeGeohash, geohashCenter, type BBox } from '@muzradar/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomId } from '../src/ids.ts';
import { MemoryPresenceStore } from '../src/modules/presence/memory.ts';
import { RedisPresenceStore } from '../src/modules/presence/redis.ts';
import { blur } from '../src/modules/presence/service.ts';
import type { PresenceRecord, PresenceStore } from '../src/modules/presence/store.ts';

const SECRET = 'contract-secret';
const T0 = 1_800_000_000_000;

/** Москва, центр; Питер; Новосибирск. */
const MOSCOW = { lat: 55.7558, lng: 37.6173 };
const SPB = { lat: 59.9386, lng: 30.3141 };
const NSK = { lat: 55.0302, lng: 82.9204 };

function record(
  userId: string,
  at: { lat: number; lng: number },
  over: Partial<PresenceRecord> = {},
): PresenceRecord {
  const cell = encodeGeohash(at.lat, at.lng, 7);
  const point = blur(userId, cell, SECRET);
  return {
    userId,
    name: `n-${userId.slice(-4)}`,
    mapAvatarUrl: null,
    visibility: 'public',
    cell,
    displayCell: point.displayCell,
    lng: point.lng,
    lat: point.lat,
    motion: 'still',
    approx: false,
    track: { id: 'audius:abc', title: 'Песня', artist: 'Кто-то', artworkUrl: null, playback: 'full' },
    playing: true,
    positionSec: 12,
    positionAt: T0,
    seenAt: T0,
    ...over,
  };
}

const uid = () => `u_${randomId(20)}`;
const around = (p: { lat: number; lng: number }, d = 0.05): BBox => [p.lng - d, p.lat - d, p.lng + d, p.lat + d];

function contract(name: string, make: () => Promise<PresenceStore>) {
  describe(`PresenceStore: ${name}`, () => {
    let store: PresenceStore;
    beforeEach(async () => {
      store = await make();
    });

    it('upsert → get возвращает ту же запись; remove отдаёт её и стирает', async () => {
      const r = record(uid(), MOSCOW);
      expect(await store.get(r.userId)).toBeNull();
      await store.upsert(r);
      expect(await store.get(r.userId)).toEqual(r);

      const moved = { ...r, ...blur(r.userId, encodeGeohash(SPB.lat, SPB.lng, 7), SECRET), cell: encodeGeohash(SPB.lat, SPB.lng, 7) };
      await store.upsert(moved);
      expect(await store.get(r.userId)).toEqual(moved);
      // старое место больше не находится
      expect((await store.searchBBox(around(MOSCOW), 10)).map((x) => x.userId)).not.toContain(r.userId);

      expect(await store.remove(r.userId)).toEqual(moved);
      expect(await store.get(r.userId)).toBeNull();
      expect(await store.remove(r.userId)).toBeNull();
      expect(await store.searchBBox(around(SPB), 10)).toEqual([]);
    });

    it('searchBBox ищет по точке отображения и соблюдает limit', async () => {
      const inside = [record(uid(), MOSCOW), record(uid(), { lat: MOSCOW.lat + 0.01, lng: MOSCOW.lng + 0.01 })];
      const outside = record(uid(), NSK);
      for (const r of [...inside, outside]) await store.upsert(r);

      const found = await store.searchBBox(around(MOSCOW), 10);
      expect(found.map((r) => r.userId).sort()).toEqual(inside.map((r) => r.userId).sort());
      expect(await store.searchBBox(around(MOSCOW), 1)).toHaveLength(1);

      // bbox, который задевает ячейку, но не точку отображения, её не находит
      const [w, s] = decodeGeohashBBox(inside[0]!.displayCell);
      const cornerOnly: BBox = [w - 0.01, s - 0.01, w + 0.0001, s + 0.0001];
      expect((await store.searchBBox(cornerOnly, 10)).map((r) => r.userId)).not.toContain(inside[0]!.userId);
    });

    it('clusters: группировка по префиксу, центр ячейки, сортировка, limit, без «для подписчиков»', async () => {
      // три точки в одной ячейке p5, одна — в соседней, одна «для подписчиков»
      const base = encodeGeohash(MOSCOW.lat, MOSCOW.lng, 5);
      const [w, s, e, n] = decodeGeohashBBox(base);
      const pts = [0.2, 0.5, 0.8].map((f) => ({ lat: s + (n - s) * f, lng: w + (e - w) * f }));
      const same = pts.map((p) => record(uid(), p));
      const other = record(uid(), { lat: n + (n - s) * 0.5, lng: w + (e - w) * 0.5 });
      const hidden = record(uid(), pts[1]!, { visibility: 'followers' });
      for (const r of [...same, other, hidden]) await store.upsert(r);

      const bbox: BBox = [w - 0.2, s - 0.2, e + 0.2, n + 0.2];
      const cells = await store.clusters(bbox, 5, 10);
      expect(cells.map((c) => c.count)).toEqual([3, 1]);
      expect(cells[0]!.cell).toBe(base);
      const [cLng, cLat] = geohashCenter(base);
      expect(cells[0]!.lng).toBeCloseTo(cLng, 9);
      expect(cells[0]!.lat).toBeCloseTo(cLat, 9);
      expect(cells[1]!.cell).toBe(other.displayCell.slice(0, 5));

      expect(await store.clusters(bbox, 5, 1)).toHaveLength(1);
      const coarse = await store.clusters(bbox, 3, 10);
      expect(coarse.reduce((sum, c) => sum + c.count, 0)).toBe(4);
      expect(coarse.every((c) => c.cell.length === 3)).toBe(true);
      // точнее публичной ячейки кластеры не бывают
      expect((await store.clusters(bbox, 9, 50)).every((c) => c.cell.length === 6)).toBe(true);
    });

    it('heartbeat продлевает только живую точку и не трогает ячейку', async () => {
      const r = record(uid(), MOSCOW);
      expect(await store.heartbeat(r.userId, { track: null, playing: false, positionSec: null }, T0)).toBeNull();
      await store.upsert(r);

      const patch = { track: null, playing: false, positionSec: 99 };
      const next = await store.heartbeat(r.userId, patch, T0 + 60_000);
      expect(next).toEqual({ ...r, ...patch, seenAt: T0 + 60_000 });
      expect(await store.get(r.userId)).toEqual(next);

      // после TTL без продления — уже не продлить
      const late = T0 + 60_000 + PRESENCE.ttlSec * 1000 + 1;
      expect(await store.heartbeat(r.userId, patch, late)).toBeNull();
    });

    it('sweep: seenAt старше TTL, positionAt старше жёсткого TTL; свежие остаются', async () => {
      const now = T0 + PRESENCE.hardTtlSec * 1000;
      const fresh = record(uid(), MOSCOW, { seenAt: now - 1_000, positionAt: now - 1_000 });
      const silent = record(uid(), MOSCOW, { seenAt: now - PRESENCE.ttlSec * 1000 - 1, positionAt: now - 200_000 });
      const edge = record(uid(), MOSCOW, { seenAt: now - PRESENCE.ttlSec * 1000, positionAt: now - 200_000 });
      // heartbeat держит точку живой, но позиция слишком старая
      const stale = record(uid(), SPB, { seenAt: now - 1_000, positionAt: now - PRESENCE.hardTtlSec * 1000 - 1 });
      for (const r of [fresh, silent, edge, stale]) await store.upsert(r);

      const removed = await store.sweep(now);
      expect(removed.map((r) => r.userId).sort()).toEqual([silent.userId, stale.userId].sort());
      expect(removed.find((r) => r.userId === silent.userId)).toEqual(silent);
      expect(await store.get(silent.userId)).toBeNull();
      expect(await store.get(stale.userId)).toBeNull();
      expect(await store.get(fresh.userId)).toEqual(fresh);
      expect(await store.get(edge.userId)).toEqual(edge);
      expect((await store.searchBBox(around(SPB), 10)).map((r) => r.userId)).not.toContain(stale.userId);

      expect(await store.sweep(now)).toEqual([]);
    });
  });
}

contract('memory', async () => new MemoryPresenceStore());

const redisUrl = process.env['REDIS_URL'];
// Без Redis рабочим остаётся MemoryPresenceStore; причина пропуска видна прямо в отчёте vitest.
const REDIS_SUITE = redisUrl
  ? 'redis'
  : 'redis — ПРОПУЩЕНО: REDIS_URL не задан. Поднять: winget install Memurai.MemuraiDeveloper (нужны права администратора), затем REDIS_URL=redis://127.0.0.1:6379';
describe.runIf(!!redisUrl)(REDIS_SUITE, () => {
  const redis = redisUrl ? new Redis(redisUrl, { protocol: 2, maxRetriesPerRequest: 2, lazyConnect: true }) : null;
  afterAll(async () => {
    if (!redis) return;
    const keys = await redis.keys('mr:{prestest-*');
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  // свой префикс на каждый тест: хранилища не видят друг друга
  contract('redis', async () => new RedisPresenceStore(redis!, { prefix: `mr:{prestest-${randomId(8)}}` }));
});
