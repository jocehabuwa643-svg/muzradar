import { PRESENCE, approxBlockBBox, type ClusterCell, type PresenceView, type TrackRef } from '@muzradar/shared';
import {
  avatarImages,
  avatarKey,
  clustersToFeatures,
  EMPTY_FEED,
  feedList,
  feedReducer,
  formatCount,
  isLiveZoom,
  listenerShape,
  listenersToFeatures,
  sameViewport,
  zonesToFeatures,
  toViewport,
  type FeedState,
} from '../features';

const SELF = 'u_00000000000000000000';

function trackRef(over: Partial<TrackRef> = {}): TrackRef {
  return { id: 'audius:1', title: 'Ночь', artist: 'Кино-клуб', artworkUrl: null, playback: 'full', ...over };
}

let seq = 0;
function view(over: Partial<PresenceView> = {}): PresenceView {
  seq += 1;
  return {
    userId: `u_${String(seq).padStart(20, 'a')}`,
    name: 'Аня',
    mapAvatarUrl: '/files/avatars/a.webp',
    lng: 37.61,
    lat: 55.75,
    precision: 6,
    motion: 'still',
    track: trackRef(),
    playing: true,
    positionSec: 12,
    updatedAt: 1000,
    ...over,
  };
}

describe('точки слушателей', () => {
  it('собирает FeatureCollection с ключом аватара и подписью трека', () => {
    const v = view({ userId: 'u_aaaaaaaaaaaaaaaaaaaa', name: 'Марк', motion: 'walk' });
    const fc = listenersToFeatures([v]);
    expect(fc.type).toBe('FeatureCollection');
    const f = fc.features[0]!;
    expect(f.geometry.coordinates).toEqual([v.lng, v.lat]);
    expect(f.properties).toMatchObject({
      userId: 'u_aaaaaaaaaaaaaaaaaaaa',
      avatarKey: 'avatar:u_aaaaaaaaaaaaaaaaaaaa',
      hasAvatar: true,
      name: 'Марк',
      trackTitle: 'Ночь',
      playing: true,
      motion: 'walk',
    });
    expect(avatarKey(v.userId)).toBe(f.properties.avatarKey);
  });

  it('без трека подпись пустая, а «играет» — ложь даже при playing', () => {
    const f = listenersToFeatures([view({ track: null, playing: true })]).features[0]!;
    expect(f.properties.trackTitle).toBe('');
    expect(f.properties.playing).toBe(false);
  });

  it('обрезает длинное название многоточием', () => {
    const long = 'Очень длинное название трека, которое не влезет на карту';
    const f = listenersToFeatures([view({ track: trackRef({ title: long }) })]).features[0]!;
    expect(f.properties.trackTitle.length).toBeLessThanOrEqual(28);
    expect(f.properties.trackTitle.endsWith('…')).toBe(true);
    expect(long.startsWith(f.properties.trackTitle.slice(0, -1).trimEnd())).toBe(true);
  });

  it('картинки — только для тех, у кого есть аватар, по абсолютному адресу', () => {
    const withAvatar = view({ userId: 'u_bbbbbbbbbbbbbbbbbbbb', mapAvatarUrl: '/files/a.webp' });
    const without = view({ userId: 'u_cccccccccccccccccccc', mapAvatarUrl: null });
    const images = avatarImages([withAvatar, without], (u) => (u ? `https://api.test${u}` : null));
    expect(images).toEqual({ 'avatar:u_bbbbbbbbbbbbbbbbbbbb': 'https://api.test/files/a.webp' });
    expect(listenersToFeatures([without]).features[0]!.properties.hasAvatar).toBe(false);
  });
});

describe('серверные кластеры', () => {
  const cells: ClusterCell[] = [
    { cell: 'ucftp', count: 3, lng: 37.6, lat: 55.7 },
    { cell: 'ucftq', count: 1520, lng: 37.7, lat: 55.8 },
  ];

  it('превращает ячейки в точки с подписью количества', () => {
    const fc = clustersToFeatures(cells);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]!.properties).toEqual({ cell: 'ucftp', count: 3, countLabel: '3' });
    expect(fc.features[1]!.geometry.coordinates).toEqual([37.7, 55.8]);
  });

  it('сокращает большие числа', () => {
    expect(formatCount(7)).toBe('7');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1520)).toBe('1,5K');
    expect(formatCount(24_300)).toBe('24K');
  });
});

describe('вьюпорт', () => {
  it('приводит границы к схеме сервера', () => {
    const vp = toViewport([37.123456789, 55.123456789, 37.9, 55.9], 13.456789);
    expect(vp.bbox).toEqual([37.12346, 55.12346, 37.9, 55.9]);
    expect(vp.zoom).toBe(13.46);
  });

  it('зажимает выход за пределы и разворачивает перевёрнутые широты', () => {
    const vp = toViewport([-200, 60, 200, 50], 30);
    expect(vp.bbox[0]).toBe(-180);
    expect(vp.bbox[2]).toBe(180);
    expect(vp.bbox[1]).toBeLessThanOrEqual(vp.bbox[3]);
    expect(vp.zoom).toBe(24);
  });

  it('через антимеридиан берёт всю долготу', () => {
    const vp = toViewport([170, 50, -170, 60], 4);
    expect(vp.bbox).toEqual([-180, 50, 180, 60]);
  });

  it('сравнивает вьюпорты по значению', () => {
    const a = toViewport([1, 2, 3, 4], 12);
    expect(sameViewport(a, toViewport([1, 2, 3, 4], 12))).toBe(true);
    expect(sameViewport(a, toViewport([1, 2, 3, 4], 12.5))).toBe(false);
    expect(sameViewport(a, null)).toBe(false);
    expect(sameViewport(null, null)).toBe(true);
  });

  it('живой режим — с PRESENCE.liveMinZoom', () => {
    expect(isLiveZoom(PRESENCE.liveMinZoom)).toBe(true);
    expect(isLiveZoom(PRESENCE.liveMinZoom - 0.01)).toBe(false);
  });
});

describe('лента присутствия', () => {
  const snapshot = (users: PresenceView[], state: FeedState = EMPTY_FEED) =>
    feedReducer(state, { type: 'snapshot', users, selfId: SELF, at: 10 });

  it('снимок заменяет прежний состав целиком', () => {
    const a = view();
    const b = view();
    const first = snapshot([a, b]);
    expect(feedList(first)).toHaveLength(2);
    const second = snapshot([b], first);
    expect(feedList(second).map((v) => v.userId)).toEqual([b.userId]);
  });

  it('дельта добавляет, обновляет и удаляет', () => {
    const a = view({ motion: 'still' });
    const b = view();
    const state = snapshot([a]);
    const next = feedReducer(state, {
      type: 'delta',
      upserts: [{ ...a, motion: 'drive', updatedAt: 2000 }, b],
      removes: [],
      selfId: SELF,
      at: 2000,
    });
    expect(next.users[a.userId]!.motion).toBe('drive');
    expect(next.users[b.userId]).toBeDefined();
    expect(next.at).toBe(2000);

    const removed = feedReducer(next, { type: 'delta', upserts: [], removes: [a.userId], selfId: SELF, at: 3000 });
    expect(removed.users[a.userId]).toBeUndefined();
    expect(feedList(removed)).toHaveLength(1);
  });

  it('в одном пакете уход из одной комнаты и приход в другую оставляют человека', () => {
    const a = view();
    const state = snapshot([a]);
    const moved = feedReducer(state, {
      type: 'delta',
      upserts: [{ ...a, lng: 37.7, updatedAt: 2000 }],
      removes: [a.userId],
      selfId: SELF,
      at: 2000,
    });
    expect(moved.users[a.userId]?.lng).toBe(37.7);
  });

  it('не откатывает состояние к более старому', () => {
    const a = view({ updatedAt: 5000, motion: 'drive' });
    const state = snapshot([a]);
    const stale = feedReducer(state, {
      type: 'delta',
      upserts: [{ ...a, motion: 'still', updatedAt: 4000 }],
      removes: [],
      selfId: SELF,
      at: 5000,
    });
    expect(stale.users[a.userId]!.motion).toBe('drive');
  });

  it('выбрасывает себя и из снимка, и из дельты', () => {
    const me = view({ userId: SELF });
    const other = view();
    const state = snapshot([me, other]);
    expect(state.users[SELF]).toBeUndefined();
    const next = feedReducer(state, { type: 'delta', upserts: [me], removes: [], selfId: SELF, at: 20 });
    expect(next.users[SELF]).toBeUndefined();
    expect(feedList(next)).toHaveLength(1);
  });

  it('ограничивает размер, оставляя самых свежих', () => {
    const users = Array.from({ length: 6 }, (_, i) => view({ updatedAt: 1000 + i }));
    const state = feedReducer(EMPTY_FEED, { type: 'snapshot', users, selfId: null, at: 1 }, 3);
    const kept = feedList(state).map((v) => v.updatedAt).sort((x, y) => x - y);
    expect(kept).toEqual([1003, 1004, 1005]);
  });

  it('не создаёт новый объект, когда менять нечего', () => {
    const state = snapshot([view()]);
    expect(feedReducer(state, { type: 'delta', upserts: [], removes: [], selfId: SELF, at: 99 })).toBe(state);
    expect(feedReducer(EMPTY_FEED, { type: 'clear' })).toBe(EMPTY_FEED);
    expect(feedList(feedReducer(state, { type: 'clear' }))).toEqual([]);
  });
});

describe('точный и приблизительный слушатель: модель отображения', () => {
  const M_PER_DEG = 111_195;

  it('точный — пин в публичной точке сервера, без зоны', () => {
    const v = view({ approx: false });
    expect(listenerShape(v)).toEqual({ kind: 'point', point: [v.lng, v.lat] });
    expect(listenersToFeatures([v]).features[0]!.properties.approx).toBe(false);
    expect(zonesToFeatures([v]).features).toEqual([]);
  });

  it('нет поля approx (старый сервер) — считаем точным', () => {
    const v = view();
    delete (v as { approx?: boolean }).approx;
    expect(listenerShape(v).kind).toBe('point');
    expect(zonesToFeatures([v]).features).toEqual([]);
  });

  it('приблизительный — квартал 1–3 км и приглушённый маркер в его центре, а не в точке', () => {
    const v = view({ approx: true });
    const shape = listenerShape(v);
    expect(shape.kind).toBe('zone');
    if (shape.kind !== 'zone') return;
    const [w, s, e, n] = shape.bbox;
    expect(shape.bbox).toEqual(approxBlockBBox(v.lat, v.lng));
    expect(shape.point).toEqual([(w + e) / 2, (s + n) / 2]);
    expect(shape.point).not.toEqual([v.lng, v.lat]);
    // публичная точка сервера лежит внутри своего квартала
    expect(v.lng).toBeGreaterThan(w);
    expect(v.lng).toBeLessThan(e);
    expect(v.lat).toBeGreaterThan(s);
    expect(v.lat).toBeLessThan(n);
    const widthM = (e - w) * M_PER_DEG * Math.cos((v.lat * Math.PI) / 180);
    const heightM = (n - s) * M_PER_DEG;
    for (const side of [widthM, heightM]) {
      expect(side).toBeGreaterThan(1_000);
      expect(side).toBeLessThan(3_000);
    }

    const marker = listenersToFeatures([v]).features[0]!;
    expect(marker.geometry.coordinates).toEqual(shape.point);
    expect(marker.properties.approx).toBe(true);
    // подпись трека сохраняется
    expect(marker.properties.trackTitle).toBe('Ночь');
  });

  it('зона — замкнутый прямоугольник квартала с userId для тапа', () => {
    const v = view({ approx: true });
    const [w, s, e, n] = approxBlockBBox(v.lat, v.lng);
    const zones = zonesToFeatures([v, view({ approx: false })]);
    expect(zones.features).toHaveLength(1);
    expect(zones.features[0]!.properties).toEqual({ userId: v.userId, playing: true });
    expect(zones.features[0]!.geometry.coordinates).toEqual([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
  });

  it('смена режима: approx → precise схлопывает зону в пин, precise → approx раскрывает её', () => {
    const coarse = view({ approx: true });
    const fine = { ...coarse, approx: false, updatedAt: coarse.updatedAt + 1 };
    expect(zonesToFeatures([coarse]).features).toHaveLength(1);
    expect(zonesToFeatures([fine]).features).toHaveLength(0);
    expect(listenersToFeatures([fine]).features[0]!.geometry.coordinates).toEqual([fine.lng, fine.lat]);
    const back = { ...fine, approx: true, updatedAt: fine.updatedAt + 1 };
    expect(zonesToFeatures([back]).features).toHaveLength(1);
  });
});
