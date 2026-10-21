import type { BBox, ClusterCell, Motion, TrackRef, Visibility } from '@muzradar/shared';

/**
 * Запись присутствия. Сырых координат нет нигде: только ячейка клиента
 * и уже размытая точка отображения.
 */
export interface PresenceRecord {
  userId: string;
  name: string;
  mapAvatarUrl: string | null;
  visibility: Visibility;
  /** Ячейка от клиента (GEO_PRECISION.client). */
  cell: string;
  /** Публичная ячейка (GEO_PRECISION.public) = префикс `cell`. */
  displayCell: string;
  /** Точка отображения внутри displayCell (детерминированное смещение). */
  lng: number;
  lat: number;
  motion: Motion;
  approx: boolean;
  track: TrackRef | null;
  playing: boolean;
  positionSec: number | null;
  /** Когда последний раз менялась ячейка, мс. */
  positionAt: number;
  /** Последнее обновление или heartbeat, мс. */
  seenAt: number;
}

export interface HeartbeatPatch {
  track: TrackRef | null;
  playing: boolean;
  positionSec: number | null;
}

export interface PresenceStore {
  readonly kind: 'memory' | 'redis';
  get(userId: string): Promise<PresenceRecord | null>;
  upsert(record: PresenceRecord): Promise<void>;
  /** Продлевает жизнь точки без смены ячейки. null — точки нет (истекла или не создавалась). */
  heartbeat(userId: string, patch: HeartbeatPatch, now: number): Promise<PresenceRecord | null>;
  remove(userId: string): Promise<PresenceRecord | null>;
  /** Точки внутри bbox (по точке отображения), не больше limit. */
  searchBBox(bbox: BBox, limit: number): Promise<PresenceRecord[]>;
  /** Количество точек по ячейкам точности `precision` внутри bbox. */
  clusters(bbox: BBox, precision: number, limit: number): Promise<ClusterCell[]>;
  /**
   * Удаляет истёкшие точки и возвращает их (чтобы разослать removes).
   * Истекла: seenAt < now − PRESENCE.ttlSec, либо positionAt < now − PRESENCE.hardTtlSec.
   */
  sweep(now: number): Promise<PresenceRecord[]>;
  close(): Promise<void>;
}
