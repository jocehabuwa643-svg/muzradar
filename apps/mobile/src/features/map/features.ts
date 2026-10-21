import { PRESENCE, approxBlockBBox, type BBox, type ClusterCell, type Motion, type PresenceView, type Viewport } from '@muzradar/shared';
import { absoluteUrl } from '@/lib/config';

export const AVATAR_KEY_PREFIX = 'avatar:';

export const avatarKey = (userId: string) => `${AVATAR_KEY_PREFIX}${userId}`;

/** Свойства точки слушателя — всё, что нужно слоям и обработчику нажатия. */
export interface ListenerProps {
  userId: string;
  avatarKey: string;
  hasAvatar: boolean;
  name: string;
  /** Пустая строка, если ничего не играет: symbol-слой просто не рисует подпись. */
  trackTitle: string;
  playing: boolean;
  motion: Motion;
  /** Приблизительная геолокация: маркер в центре квартала, приглушённый; сам квартал — отдельный слой. */
  approx: boolean;
}

export type ListenerFeature = GeoJSON.Feature<GeoJSON.Point, ListenerProps>;
export type ListenerCollection = GeoJSON.FeatureCollection<GeoJSON.Point, ListenerProps>;

const TITLE_MAX = 28;

function shortTitle(title: string): string {
  const t = title.trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}

// ─── как рисовать слушателя ──────────────────────────────────────────────────

/**
 * Точный слушатель — пин в размытой точке сервера (публичная ячейка ~0,7 км).
 * Приблизительный — квартал 2×2 публичных ячеек, маркер в его центре: рисовать его точкой
 * значило бы врать о точности. Квартал восстанавливается из той же публичной точки —
 * она всегда лежит внутри квартала, новых координат для этого не нужно.
 * Нет флага (старый сервер) — точный.
 */
export type ListenerShape =
  | { kind: 'point'; point: [number, number] }
  | { kind: 'zone'; point: [number, number]; bbox: BBox };

export function listenerShape(v: PresenceView): ListenerShape {
  if (v.approx !== true) return { kind: 'point', point: [v.lng, v.lat] };
  const bbox = approxBlockBBox(v.lat, v.lng);
  const [w, s, e, n] = bbox;
  return { kind: 'zone', point: [(w + e) / 2, (s + n) / 2], bbox };
}

export function listenersToFeatures(views: readonly PresenceView[]): ListenerCollection {
  return {
    type: 'FeatureCollection',
    features: views.map((v) => ({
      type: 'Feature',
      id: v.userId,
      geometry: { type: 'Point', coordinates: listenerShape(v).point },
      properties: {
        userId: v.userId,
        avatarKey: avatarKey(v.userId),
        hasAvatar: v.mapAvatarUrl !== null,
        name: v.name,
        trackTitle: v.track ? shortTitle(v.track.title) : '',
        playing: v.track !== null && v.playing,
        motion: v.motion,
        approx: v.approx === true,
      },
    })),
  };
}

export interface ZoneProps {
  userId: string;
  playing: boolean;
}

export type ZoneCollection = GeoJSON.FeatureCollection<GeoJSON.Polygon, ZoneProps>;

/** Кварталы приблизительных слушателей — полупрозрачные зоны под маркерами. */
export function zonesToFeatures(views: readonly PresenceView[]): ZoneCollection {
  const features: GeoJSON.Feature<GeoJSON.Polygon, ZoneProps>[] = [];
  for (const v of views) {
    const shape = listenerShape(v);
    if (shape.kind !== 'zone') continue;
    const [w, s, e, n] = shape.bbox;
    features.push({
      type: 'Feature',
      id: v.userId,
      geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      properties: { userId: v.userId, playing: v.track !== null && v.playing },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Картинки для <Images>: ключ `avatar:<userId>` → абсолютный адрес круглого аватара. */
export function avatarImages(
  views: readonly PresenceView[],
  resolve: (url: string | null) => string | null = absoluteUrl,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of views) {
    const url = resolve(v.mapAvatarUrl);
    if (url) out[avatarKey(v.userId)] = url;
  }
  return out;
}

export interface CellProps {
  cell: string;
  count: number;
  countLabel: string;
}

export type CellCollection = GeoJSON.FeatureCollection<GeoJSON.Point, CellProps>;

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toString().replace('.', ',')}K`;
  return `${Math.floor(n / 1000)}K`;
}

export function clustersToFeatures(cells: readonly ClusterCell[]): CellCollection {
  return {
    type: 'FeatureCollection',
    features: cells.map((c) => ({
      type: 'Feature',
      id: c.cell,
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { cell: c.cell, count: c.count, countLabel: formatCount(c.count) },
    })),
  };
}

export const EMPTY_COLLECTION: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// ─── вьюпорт ─────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Границы карты → вьюпорт, который пропустит схема сервера.
 * При переходе через антимеридиан (w > e) берём всю долготу — такой зум всё равно кластерный.
 */
export function toViewport(bounds: readonly [number, number, number, number], zoom: number): Viewport {
  let [w, s, e, n] = bounds;
  if (w > e) {
    w = -180;
    e = 180;
  }
  if (s > n) [s, n] = [n, s];
  const bbox: BBox = [round(clamp(w, -180, 180)), round(clamp(s, -90, 90)), round(clamp(e, -180, 180)), round(clamp(n, -90, 90))];
  return { bbox: [...bbox] as [number, number, number, number], zoom: Math.round(clamp(zoom, 0, 24) * 100) / 100 };
}

export function sameViewport(a: Viewport | null, b: Viewport | null): boolean {
  if (!a || !b) return a === b;
  return a.zoom === b.zoom && a.bbox.every((v, i) => v === b.bbox[i]);
}

export function isLiveZoom(zoom: number): boolean {
  return zoom >= PRESENCE.liveMinZoom;
}

// ─── лента присутствия ───────────────────────────────────────────────────────

/** Вдвое больше снимка: соседние комнаты догружаются дельтами. */
export const FEED_MAX = PRESENCE.snapshotLimit * 2;

export interface FeedState {
  users: Readonly<Record<string, PresenceView>>;
  /** Время последнего применённого изменения (серверное, мс). */
  at: number;
}

export type FeedAction =
  | { type: 'snapshot'; users: readonly PresenceView[]; selfId: string | null; at?: number }
  | { type: 'delta'; upserts: readonly PresenceView[]; removes: readonly string[]; selfId: string | null; at: number }
  | { type: 'clear' };

export const EMPTY_FEED: FeedState = { users: {}, at: 0 };

function capped(users: Record<string, PresenceView>, max: number): Record<string, PresenceView> {
  const list = Object.values(users);
  if (list.length <= max) return users;
  // Лишние — самые давно обновлённые: они дальше всего от того, что сейчас происходит.
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return Object.fromEntries(list.slice(0, max).map((v) => [v.userId, v]));
}

export function feedReducer(state: FeedState, action: FeedAction, max: number = FEED_MAX): FeedState {
  switch (action.type) {
    case 'clear':
      return Object.keys(state.users).length === 0 ? state : EMPTY_FEED;

    case 'snapshot': {
      const users: Record<string, PresenceView> = {};
      for (const v of action.users) {
        if (v.userId === action.selfId) continue;
        const prev = users[v.userId];
        if (!prev || prev.updatedAt <= v.updatedAt) users[v.userId] = v;
      }
      return { users: capped(users, max), at: action.at ?? state.at };
    }

    case 'delta': {
      if (action.upserts.length === 0 && action.removes.length === 0) return state;
      const users: Record<string, PresenceView> = { ...state.users };
      let changed = false;
      // Сначала удаления: если человек в одном пакете ушёл из одной комнаты и пришёл в другую, он остаётся.
      for (const id of action.removes) {
        if (id in users) {
          delete users[id];
          changed = true;
        }
      }
      for (const v of action.upserts) {
        if (v.userId === action.selfId) continue;
        const prev = users[v.userId];
        if (prev && prev.updatedAt > v.updatedAt) continue;
        users[v.userId] = v;
        changed = true;
      }
      if (!changed) return state;
      return { users: capped(users, max), at: Math.max(state.at, action.at) };
    }
  }
}

export function feedList(state: FeedState): PresenceView[] {
  return Object.values(state.users);
}
