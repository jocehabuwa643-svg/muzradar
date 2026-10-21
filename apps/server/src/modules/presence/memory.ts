import { PRESENCE, geohashCenter, type BBox, type ClusterCell } from '@muzradar/shared';
import type { HeartbeatPatch, PresenceRecord, PresenceStore } from './store.ts';

/** Истекла ли точка по правилам store.ts: нет обновлений ttlSec или позиция старше hardTtlSec. */
export function isExpired(record: PresenceRecord, now: number): boolean {
  return record.seenAt < now - PRESENCE.ttlSec * 1000 || record.positionAt < now - PRESENCE.hardTtlSec * 1000;
}

export function inBBox(record: Pick<PresenceRecord, 'lng' | 'lat'>, [w, s, e, n]: BBox): boolean {
  return record.lng >= w && record.lng <= e && record.lat >= s && record.lat <= n;
}

/**
 * Кластеры по уже отобранным точкам. Считаются только публичные: точки «для подписчиков»
 * хранятся, но незнакомцам не видны даже числом.
 */
export function groupClusters(records: Iterable<PresenceRecord>, precision: number, limit: number): ClusterCell[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.visibility !== 'public') continue;
    // точнее публичной ячейки не группируем: это выдало бы больше, чем видно на карте
    const cell = r.displayCell.slice(0, Math.min(precision, r.displayCell.length));
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map(([cell, count]) => {
      const [lng, lat] = geohashCenter(cell);
      return { cell, count, lng, lat };
    });
}

/** Ближние к центру bbox — первыми (как GEOSEARCH … ASC в Redis). */
export function byDistanceToCenter([w, s, e, n]: BBox) {
  const cLng = (w + e) / 2;
  const cLat = (s + n) / 2;
  const k = Math.cos((cLat * Math.PI) / 180);
  const d = (r: PresenceRecord) => ((r.lng - cLng) * k) ** 2 + (r.lat - cLat) ** 2;
  return (a: PresenceRecord, b: PresenceRecord) => d(a) - d(b);
}

/** Присутствие в памяти процесса: dev, тесты, одна нода. */
export class MemoryPresenceStore implements PresenceStore {
  readonly kind = 'memory' as const;
  private readonly records = new Map<string, PresenceRecord>();

  async get(userId: string): Promise<PresenceRecord | null> {
    const r = this.records.get(userId);
    return r ? { ...r } : null;
  }

  async upsert(record: PresenceRecord): Promise<void> {
    this.records.set(record.userId, { ...record });
  }

  async heartbeat(userId: string, patch: HeartbeatPatch, now: number): Promise<PresenceRecord | null> {
    const r = this.records.get(userId);
    if (!r) return null;
    // истёкшую, но ещё не выметенную точку не воскрешаем: клиент должен прислать полное обновление
    if (isExpired(r, now)) return null;
    const next: PresenceRecord = { ...r, track: patch.track, playing: patch.playing, positionSec: patch.positionSec, seenAt: now };
    this.records.set(userId, next);
    return { ...next };
  }

  async remove(userId: string): Promise<PresenceRecord | null> {
    const r = this.records.get(userId);
    if (!r) return null;
    this.records.delete(userId);
    return r;
  }

  async searchBBox(bbox: BBox, limit: number): Promise<PresenceRecord[]> {
    const out: PresenceRecord[] = [];
    for (const r of this.records.values()) if (inBBox(r, bbox)) out.push({ ...r });
    return out.sort(byDistanceToCenter(bbox)).slice(0, Math.max(0, limit));
  }

  async clusters(bbox: BBox, precision: number, limit: number): Promise<ClusterCell[]> {
    const inside = [...this.records.values()].filter((r) => inBBox(r, bbox));
    return groupClusters(inside, precision, limit);
  }

  async sweep(now: number): Promise<PresenceRecord[]> {
    const removed: PresenceRecord[] = [];
    for (const [id, r] of this.records) {
      if (!isExpired(r, now)) continue;
      this.records.delete(id);
      removed.push(r);
    }
    return removed;
  }

  async close(): Promise<void> {
    this.records.clear();
  }
}
