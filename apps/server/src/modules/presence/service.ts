import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  GEO_PRECISION,
  PRESENCE,
  coverBBox,
  displayPointInCell,
  presenceRoom,
  type BBox,
  type ClustersResponse,
  type PresenceHeartbeat,
  type PresenceUpdate,
  type PresenceView,
  type Visibility,
} from '@muzradar/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { avatarUrl } from '../../types.ts';
import type { PresenceRecord } from './store.ts';

export interface PresenceEventMap {
  /** Запись сохранена (обновление или heartbeat). prev — что было до этого. */
  changed: [record: PresenceRecord, prev: PresenceRecord | null];
  /** Точка исчезла: истекла, невидимка или удалённый аккаунт. */
  removed: [userId: string];
}
export type PresenceEvents = EventEmitter<PresenceEventMap>;

declare module 'fastify' {
  interface FastifyInstance {
    /** События присутствия этой ноды (на них живёт «слушать вместе»). */
    presenceEvents: PresenceEvents;
  }
}

// ─── размытие ────────────────────────────────────────────────────────────────

/**
 * Точка отображения: публичная ячейка + смещение из HMAC(secret, userId:ячейка).
 * Ответ зависит только от ячейки, поэтому усреднение ничего не даёт,
 * а без секрета смещение не восстановить по одной известной точке.
 */
export function blur(userId: string, cell: string, secret: string): { displayCell: string; lng: number; lat: number } {
  // короче публичной ячейки не бывает по схеме, но и тогда точнее p6 не станет
  const displayCell = cell.slice(0, GEO_PRECISION.public);
  const h = createHmac('sha256', secret).update(`${userId}:${displayCell}`).digest();
  const [lng, lat] = displayPointInCell(displayCell, h.readUInt16BE(0) / 0xffff, h.readUInt16BE(2) / 0xffff);
  return { displayCell, lng, lat };
}

export function toView(r: PresenceRecord): PresenceView {
  return {
    userId: r.userId,
    name: r.name,
    mapAvatarUrl: r.mapAvatarUrl,
    lng: r.lng,
    lat: r.lat,
    precision: GEO_PRECISION.public,
    approx: r.approx,
    motion: r.motion,
    track: r.track,
    playing: r.playing,
    positionSec: r.positionSec,
    updatedAt: r.seenAt,
  };
}

/** Незнакомцам видны только публичные точки. «Для подписчиков» — фаза 1. */
export const isPublic = (r: PresenceRecord) => r.visibility === 'public';

export const ROOM_PREFIX = `g${GEO_PRECISION.roomFine}:`;
export const roomOf = (r: PresenceRecord) => presenceRoom(r.displayCell, GEO_PRECISION.roomFine);

/** Изменилось ли то, что видно на карте. Позиция в треке — нет: её не рассылаем. */
function visibleChange(a: PresenceRecord, b: PresenceRecord): boolean {
  return (
    a.lng !== b.lng ||
    a.lat !== b.lat ||
    (a.track?.id ?? null) !== (b.track?.id ?? null) ||
    a.playing !== b.playing ||
    a.motion !== b.motion ||
    // Точка квартала может совпасть с прежней, а рисовать её надо уже зоной — смену режима рассылаем всегда
    a.approx !== b.approx ||
    a.name !== b.name ||
    a.mapAvatarUrl !== b.mapAvatarUrl
  );
}

/** Сколько ячеек отдаёт GET /clusters. */
export const CLUSTER_LIMIT = 300;

export function clusterPrecision(zoom: number): number {
  if (zoom >= 9) return 5;
  if (zoom >= 7) return 4;
  if (zoom >= 5) return 3;
  return 2;
}

// ─── пачки по комнатам ───────────────────────────────────────────────────────

export interface DeltaPayload {
  upserts: PresenceView[];
  removes: string[];
  at: number;
}

/**
 * Копит изменения по комнатам и рассылает раз в интервал.
 * В комнате: последняя запись побеждает, удаление отменяет upsert и наоборот.
 */
export class RoomBatcher {
  private pending = new Map<string, { up: Map<string, PresenceView>; rm: Set<string> }>();
  private readonly timer: NodeJS.Timeout;
  private readonly emit: (room: string, payload: DeltaPayload) => void;
  private readonly now: () => number;

  constructor(emit: (room: string, payload: DeltaPayload) => void, now: () => number = Date.now, intervalMs: number = PRESENCE.batchMs) {
    this.emit = emit;
    this.now = now;
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  upsert(room: string, view: PresenceView): void {
    const b = this.bucket(room);
    b.rm.delete(view.userId);
    b.up.set(view.userId, view);
  }

  remove(room: string, userId: string): void {
    const b = this.bucket(room);
    b.up.delete(userId);
    b.rm.add(userId);
  }

  flush(): void {
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    const at = this.now();
    // Сначала все удаления, потом все upsert: клиент, подписанный на обе комнаты,
    // при переходе A→B должен увидеть «убрать из A», а не потерять точку из B.
    for (const [room, b] of batch) if (b.rm.size) this.emit(room, { upserts: [], removes: [...b.rm], at });
    for (const [room, b] of batch) if (b.up.size) this.emit(room, { upserts: [...b.up.values()], removes: [], at });
  }

  stop(): void {
    clearInterval(this.timer);
    this.pending.clear();
  }

  private bucket(room: string) {
    let b = this.pending.get(room);
    if (!b) {
      b = { up: new Map(), rm: new Set() };
      this.pending.set(room, b);
    }
    return b;
  }
}

// ─── лимиты на сокет ─────────────────────────────────────────────────────────

export const HEARTBEAT_MIN_INTERVAL_MS = 20_000;
const VIEWPORT_PER_SEC = 2;

export class SocketLimits {
  private lastUpdate = Number.NEGATIVE_INFINITY;
  private lastHeartbeat = Number.NEGATIVE_INFINITY;
  private viewports: number[] = [];
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  update(): boolean {
    const t = this.now();
    if (t - this.lastUpdate < PRESENCE.minIntervalMs) return false;
    this.lastUpdate = t;
    return true;
  }

  heartbeat(): boolean {
    const t = this.now();
    if (t - this.lastHeartbeat < HEARTBEAT_MIN_INTERVAL_MS) return false;
    this.lastHeartbeat = t;
    return true;
  }

  viewport(): boolean {
    const t = this.now();
    this.viewports = this.viewports.filter((x) => t - x < 1000);
    if (this.viewports.length >= VIEWPORT_PER_SEC) return false;
    this.viewports.push(t);
    return true;
  }
}

// ─── кэш профилей ────────────────────────────────────────────────────────────

export interface PresenceUser {
  name: string | null;
  avatarHash: string | null;
  visibility: Visibility;
  onboardedAt: Date | null;
  deletedAt: Date | null;
}

/** Профиль нужен на каждое обновление; минута устаревания для имени и видимости допустима. */
export class UserCache {
  private readonly entries = new Map<string, { value: PresenceUser | null; expiresAt: number }>();
  private readonly db: Db;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(db: Db, now: () => number, ttlMs = 60_000, max = 10_000) {
    this.db = db;
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
  }

  async get(userId: string): Promise<PresenceUser | null> {
    const t = this.now();
    const hit = this.entries.get(userId);
    if (hit && hit.expiresAt > t) return hit.value;
    const [row] = await this.db
      .select({
        name: users.name,
        avatarHash: users.avatarHash,
        visibility: users.visibility,
        onboardedAt: users.onboardedAt,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const value = row ?? null;
    this.entries.delete(userId);
    if (this.entries.size >= this.max) {
      // Map хранит порядок вставки: первый ключ — самый старый
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(userId, { value, expiresAt: t + this.ttlMs });
    return value;
  }

  invalidate(userId: string): void {
    this.entries.delete(userId);
  }
}

// ─── сервис ──────────────────────────────────────────────────────────────────

export type UpdateOutcome = 'stored' | 'hidden' | 'ignored';
export type HeartbeatOutcome = 'extended' | 'missing' | 'hidden' | 'ignored';

/** Один путь для сокета и HTTP: профиль → размытие → хранилище → рассылка → события. */
export class PresenceService {
  readonly batcher: RoomBatcher;
  readonly users: UserCache;
  readonly events: PresenceEvents;
  private readonly app: FastifyInstance;

  constructor(app: FastifyInstance, events: PresenceEvents) {
    this.app = app;
    this.events = events;
    this.batcher = new RoomBatcher(
      (room, payload) => app.io.to(room).emit('presence:delta', payload),
      () => app.now(),
    );
    this.users = new UserCache(app.db, () => app.now());
  }

  async update(userId: string, input: PresenceUpdate): Promise<UpdateOutcome> {
    const user = await this.users.get(userId);
    if (!user || user.deletedAt || !user.onboardedAt) {
      await this.remove(userId);
      return 'ignored';
    }
    if (user.visibility === 'ghost') {
      // невидимку не храним вовсе, даже без рассылки
      await this.remove(userId);
      return 'hidden';
    }
    const now = this.app.now();
    const store = this.app.presence;
    const prev = await store.get(userId);
    const point = blur(userId, input.cell, this.app.config.presenceJitterSecret);
    const record: PresenceRecord = {
      userId,
      ...this.profileFields(user),
      cell: input.cell,
      displayCell: point.displayCell,
      lng: point.lng,
      lat: point.lat,
      motion: input.motion,
      approx: input.approx,
      track: input.track,
      playing: input.playing,
      positionSec: input.positionSec,
      // полное обновление = свежий фикс позиции, даже если ячейка та же
      positionAt: now,
      seenAt: now,
    };
    await store.upsert(record);
    this.publish(prev, record);
    return 'stored';
  }

  /** Продлевает только существующую точку: без ячейки новую точку не создать. */
  async heartbeat(userId: string, patch: PresenceHeartbeat): Promise<HeartbeatOutcome> {
    const user = await this.users.get(userId);
    if (!user || user.deletedAt || !user.onboardedAt) {
      await this.remove(userId);
      return 'ignored';
    }
    if (user.visibility === 'ghost') {
      await this.remove(userId);
      return 'hidden';
    }
    const store = this.app.presence;
    const prev = await store.get(userId);
    let next = await store.heartbeat(userId, patch, this.app.now());
    if (!prev || !next) return 'missing';
    // имя, аватар и видимость могли смениться, пока точка жила на heartbeat
    const profile = this.profileFields(user);
    if (
      profile.name !== next.name ||
      profile.mapAvatarUrl !== next.mapAvatarUrl ||
      profile.visibility !== next.visibility
    ) {
      next = { ...next, ...profile };
      await store.upsert(next);
    }
    this.publish(prev, next);
    return 'extended';
  }

  async remove(userId: string): Promise<void> {
    const prev = await this.app.presence.remove(userId);
    if (prev) this.announceRemoved(prev);
  }

  async sweep(): Promise<number> {
    const removed = await this.app.presence.sweep(this.app.now());
    for (const r of removed) this.announceRemoved(r);
    return removed.length;
  }

  /** Комнаты вьюпорта; null — зум мелкий или вьюпорт слишком большой: только кластеры. */
  viewportRooms(bbox: BBox, zoom: number): string[] | null {
    if (zoom < PRESENCE.liveMinZoom) return null;
    const cells = coverBBox(bbox, GEO_PRECISION.roomFine, PRESENCE.maxRooms);
    return cells ? cells.map((c) => presenceRoom(c, GEO_PRECISION.roomFine)) : null;
  }

  async snapshot(bbox: BBox, zoom: number): Promise<PresenceView[]> {
    if (zoom < PRESENCE.liveMinZoom) return [];
    const records = await this.app.presence.searchBBox(bbox, PRESENCE.snapshotLimit);
    return records.filter(isPublic).map(toView);
  }

  async clusters(bbox: BBox, zoom: number): Promise<ClustersResponse> {
    const precision = clusterPrecision(zoom);
    return { precision, cells: await this.app.presence.clusters(bbox, precision, CLUSTER_LIMIT) };
  }

  stop(): void {
    this.batcher.stop();
  }

  private profileFields(user: PresenceUser): Pick<PresenceRecord, 'name' | 'mapAvatarUrl' | 'visibility'> {
    return {
      name: user.name ?? '',
      mapAvatarUrl: user.avatarHash ? avatarUrl(this.app.config, user.avatarHash, 'map') : null,
      visibility: user.visibility,
    };
  }

  /** Рассылка только при видимых изменениях; смена комнаты — удаление из старой и upsert в новую. */
  private publish(prev: PresenceRecord | null, next: PresenceRecord): void {
    const prevRoom = prev && isPublic(prev) ? roomOf(prev) : null;
    const nextRoom = isPublic(next) ? roomOf(next) : null;
    if (prev && prevRoom && prevRoom !== nextRoom) this.batcher.remove(prevRoom, prev.userId);
    if (nextRoom && (prevRoom !== nextRoom || !prev || visibleChange(prev, next))) {
      this.batcher.upsert(nextRoom, toView(next));
    }
    this.events.emit('changed', next, prev);
  }

  private announceRemoved(record: PresenceRecord): void {
    if (isPublic(record)) this.batcher.remove(roomOf(record), record.userId);
    this.events.emit('removed', record.userId);
  }
}
