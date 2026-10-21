import {
  GEO_PRECISION,
  PRESENCE,
  REALTIME_PATH,
  approxBlockBBox,
  approxCell,
  decodeGeohashBBox,
  encodeGeohash,
  type AckResult,
  type BBox,
  type ClientToServerEvents,
  type PresenceUpdate,
  type PresenceView,
  type ServerToClientEvents,
  type TrackRef,
  type ViewportAck,
} from '@muzradar/shared';
import { eq } from 'drizzle-orm';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { users } from '../src/db/schema.ts';
import { randomId } from '../src/ids.ts';
import { MemoryPresenceStore } from '../src/modules/presence/memory.ts';
import { RoomBatcher, SocketLimits, blur, clusterPrecision, type DeltaPayload } from '../src/modules/presence/service.ts';
import type { PresenceRecord } from '../src/modules/presence/store.ts';
import { authDevice, bearer, createTestContext, onboardUser, type TestContext } from './helpers.ts';

// ─── общие помощники ─────────────────────────────────────────────────────────

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function openSocket(baseUrl: string, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s: ClientSocket = connect(baseUrl, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      forceNew: true,
    });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (err) => {
      s.close();
      reject(err);
    });
  });
}

function ask<T = null>(socket: ClientSocket, event: keyof ClientToServerEvents, payload: unknown): Promise<AckResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет ack на ${event}`)), 5_000);
    (socket.emit as unknown as (ev: string, ...args: unknown[]) => void)(event, payload, (res: AckResult<T>) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function collectDeltas(socket: ClientSocket): DeltaPayload[] {
  const got: DeltaPayload[] = [];
  socket.on('presence:delta', (p) => got.push(p));
  return got;
}

async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 4_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const upsertOf = (deltas: DeltaPayload[], userId: string) =>
  deltas.flatMap((d) => d.upserts).find((u) => u.userId === userId);
const mentions = (deltas: DeltaPayload[], userId: string) =>
  deltas.some((d) => d.removes.includes(userId) || d.upserts.some((u) => u.userId === userId));

const MOSCOW = { lat: 55.7558, lng: 37.6173 };
const NSK = { lat: 55.0302, lng: 82.9204 };
const cellAt = (p: { lat: number; lng: number }) => encodeGeohash(p.lat, p.lng, GEO_PRECISION.client);
const MOSCOW_VIEW: BBox = [MOSCOW.lng - 0.035, MOSCOW.lat - 0.02, MOSCOW.lng + 0.035, MOSCOW.lat + 0.02];
const bboxParam = (b: BBox) => b.join(',');

const track = (id: string): TrackRef => ({ id, title: 'Трек', artist: 'Артист', artworkUrl: null, playback: 'full' });
const update = (cell: string, over: Partial<PresenceUpdate> = {}): PresenceUpdate => ({
  cell,
  motion: 'walk',
  approx: false,
  track: track('audius:one'),
  playing: true,
  positionSec: 10,
  ...over,
});

// ─── размытие ────────────────────────────────────────────────────────────────

describe('размытие позиции', () => {
  const cells = Array.from({ length: 200 }, (_, i) =>
    encodeGeohash(-60 + ((i * 7.3) % 120), -170 + ((i * 13.7) % 340), GEO_PRECISION.client),
  );

  it('детерминировано и зависит только от публичной ячейки', () => {
    const user = `u_${randomId(20)}`;
    for (const cell of cells.slice(0, 20)) {
      expect(blur(user, cell, 's1')).toEqual(blur(user, cell, 's1'));
      // соседние мелкие ячейки внутри одной p6 дают ту же точку: движение внутри ячейки не видно
      const sibling = cell.slice(0, 6) + (cell[6] === '0' ? '1' : '0');
      expect(blur(user, sibling, 's1')).toEqual(blur(user, cell, 's1'));
    }
  });

  it('точка лежит внутри ячейки p6 с отступом 15 % от границ', () => {
    for (const [i, cell] of cells.entries()) {
      const { displayCell, lng, lat } = blur(`u_${randomId(20)}`, cell, `secret-${i}`);
      expect(displayCell).toBe(cell.slice(0, GEO_PRECISION.public));
      const [w, s, e, n] = decodeGeohashBBox(displayCell);
      const mx = (e - w) * 0.15 - 1e-5;
      const my = (n - s) * 0.15 - 1e-5;
      expect(lng).toBeGreaterThanOrEqual(w + mx);
      expect(lng).toBeLessThanOrEqual(e - mx);
      expect(lat).toBeGreaterThanOrEqual(s + my);
      expect(lat).toBeLessThanOrEqual(n - my);
    }
  });

  it('разные пользователи в одной ячейке получают разные точки; секрет меняет смещение', () => {
    const cell = cellAt(MOSCOW);
    const points = new Set(Array.from({ length: 50 }, () => JSON.stringify(blur(`u_${randomId(20)}`, cell, 's'))));
    expect(points.size).toBeGreaterThan(45);
    const user = `u_${randomId(20)}`;
    expect(blur(user, cell, 'a')).not.toEqual(blur(user, cell, 'b'));
  });

  it('точность кластеров по зуму', () => {
    expect([2, 4.9, 5, 6.9, 7, 8.9, 9, 11.9].map(clusterPrecision)).toEqual([2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

// ─── пачки ───────────────────────────────────────────────────────────────────

describe('RoomBatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const view = (userId: string, lng = 37.6): PresenceView => ({
    userId,
    name: 'x',
    mapAvatarUrl: null,
    lng,
    lat: 55.7,
    precision: 6,
    motion: 'still',
    track: null,
    playing: false,
    positionSec: null,
    updatedAt: 1,
  });

  it('копит за интервал: последний upsert побеждает, удаление отменяет upsert и наоборот', () => {
    vi.useFakeTimers();
    const sent: Array<[string, DeltaPayload]> = [];
    const b = new RoomBatcher((room, p) => sent.push([room, p]), () => 777);

    b.upsert('g5:aaaaa', view('u1', 1));
    b.upsert('g5:aaaaa', view('u1', 2));
    b.upsert('g5:aaaaa', view('u2'));
    b.remove('g5:aaaaa', 'u2');
    b.remove('g5:aaaaa', 'u3');
    b.upsert('g5:aaaaa', view('u3'));
    vi.advanceTimersByTime(PRESENCE.batchMs - 1);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sent).toEqual([
      ['g5:aaaaa', { upserts: [], removes: ['u2'], at: 777 }],
      ['g5:aaaaa', { upserts: [view('u1', 2), view('u3')], removes: [], at: 777 }],
    ]);

    // пустой интервал ничего не шлёт
    vi.advanceTimersByTime(PRESENCE.batchMs * 3);
    expect(sent).toHaveLength(2);
    b.stop();
  });

  it('удаления всех комнат уходят раньше upsert: переход между комнатами не теряет точку', () => {
    vi.useFakeTimers();
    const sent: Array<[string, DeltaPayload]> = [];
    const b = new RoomBatcher((room, p) => sent.push([room, p]));
    b.upsert('g5:bbbbb', view('u9')); // комната B появилась в пачке раньше
    b.upsert('g5:bbbbb', view('u1'));
    b.remove('g5:aaaaa', 'u1');
    vi.advanceTimersByTime(PRESENCE.batchMs);
    expect(sent.map(([room, p]) => [room, p.removes.length, p.upserts.length])).toEqual([
      ['g5:aaaaa', 1, 0],
      ['g5:bbbbb', 0, 2],
    ]);
    b.stop();
    b.upsert('g5:ccccc', view('u1'));
    vi.advanceTimersByTime(PRESENCE.batchMs * 2);
    expect(sent).toHaveLength(2);
  });

  it('лимиты сокета', () => {
    let t = 1_000_000;
    const l = new SocketLimits(() => t);
    expect(l.update()).toBe(true);
    t += PRESENCE.minIntervalMs - 1;
    expect(l.update()).toBe(false);
    t += 1;
    expect(l.update()).toBe(true);

    expect(l.heartbeat()).toBe(true);
    t += 19_999;
    expect(l.heartbeat()).toBe(false);
    t += 1;
    expect(l.heartbeat()).toBe(true);

    expect(l.viewport()).toBe(true);
    expect(l.viewport()).toBe(true);
    expect(l.viewport()).toBe(false);
    t += 1_000;
    expect(l.viewport()).toBe(true);
  });
});

// ─── сквозные: сокет и HTTP ──────────────────────────────────────────────────

describe('присутствие: сокет и HTTP', () => {
  let ctx: TestContext;
  let store: MemoryPresenceStore;
  const sockets: ClientSocket[] = [];
  let alice: Awaited<ReturnType<typeof onboardUser>>;
  let boris: Awaited<ReturnType<typeof onboardUser>>;
  let vera: Awaited<ReturnType<typeof onboardUser>>;

  const open = async (token: string) => {
    const s = await openSocket(ctx.baseUrl!, token);
    sockets.push(s);
    return s;
  };
  const setVisibility = (id: string, visibility: 'public' | 'followers' | 'ghost') =>
    ctx.app.db.update(users).set({ visibility }).where(eq(users.id, id));
  const get = (url: string, token: string) => ctx.app.inject({ method: 'GET', url, headers: bearer(token) });

  beforeAll(async () => {
    store = new MemoryPresenceStore();
    ctx = await createTestContext({ presence: store, listen: true });
    alice = await onboardUser(ctx.app, { name: 'Алиса' });
    boris = await onboardUser(ctx.app, { name: 'Борис' });
    vera = await onboardUser(ctx.app, { name: 'Вера' });
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await ctx?.close();
  });

  it('A видит B размытым до p6 с именем и аватаром, но не C из другого города', async () => {
    const [sa, sb, sc] = await Promise.all([open(alice.token), open(boris.token), open(vera.token)]);
    const deltas = collectDeltas(sa);

    const vp = await ask<ViewportAck>(sa, 'viewport:set', { bbox: MOSCOW_VIEW, zoom: 14 });
    expect(vp.ok).toBe(true);
    if (!vp.ok) return;
    expect(vp.data.mode).toBe('live');
    expect(vp.data.rooms).toBeGreaterThan(0);
    expect(vp.data.rooms).toBeLessThanOrEqual(PRESENCE.maxRooms);

    const bCell = cellAt(MOSCOW);
    expect(await ask(sb, 'presence:update', update(bCell))).toEqual({ ok: true, data: null });
    expect(await ask(sc, 'presence:update', update(cellAt(NSK)))).toEqual({ ok: true, data: null });

    const seen = await waitFor(() => upsertOf(deltas, boris.me.id));
    expect(seen.precision).toBe(GEO_PRECISION.public);
    expect(seen.name).toBe('Борис');
    expect(seen.mapAvatarUrl).toMatch(/^\/v1\/avatars\/[^/]+\/map\.webp$/);
    expect(seen.mapAvatarUrl).toBe(boris.me.mapAvatarUrl);
    expect(seen.track?.id).toBe('audius:one');
    expect(seen.approx).toBe(false);
    const [w, s, e, n] = decodeGeohashBBox(bCell.slice(0, 6));
    expect(seen.lng).toBeGreaterThan(w);
    expect(seen.lng).toBeLessThan(e);
    expect(seen.lat).toBeGreaterThan(s);
    expect(seen.lat).toBeLessThan(n);
    expect(Object.keys(seen).sort()).toEqual(
      ['approx', 'lat', 'lng', 'mapAvatarUrl', 'motion', 'name', 'playing', 'positionSec', 'precision', 'track', 'updatedAt', 'userId'].sort(),
    );

    await sleep(PRESENCE.batchMs + 300);
    expect(mentions(deltas, vera.me.id)).toBe(false);

    // в хранилище — только ячейка клиента и размытая точка, никаких других координат
    const stored = (await store.get(boris.me.id))!;
    expect(Object.keys(stored).sort()).toEqual(
      [
        'approx', 'cell', 'displayCell', 'lat', 'lng', 'mapAvatarUrl', 'motion', 'name', 'playing',
        'positionAt', 'positionSec', 'seenAt', 'track', 'userId', 'visibility',
      ].sort(),
    );
    expect(stored.cell).toBe(bCell);
    expect([stored.lng, stored.lat]).toEqual([seen.lng, seen.lat]);

    // снимок вьюпорта отдаёт то же самое
    ctx.clock.now += 1_000;
    const again = await ask<ViewportAck>(sa, 'viewport:set', { bbox: MOSCOW_VIEW, zoom: 14 });
    expect(again.ok && again.data.users.map((u) => u.userId)).toEqual([boris.me.id]);
  });

  it('повтор без видимых изменений не рассылается; смена трека — рассылается', async () => {
    const sa = await open(alice.token);
    const sb = await open(boris.token);
    const deltas = collectDeltas(sa);
    ctx.clock.now += 1_000;
    await ask(sa, 'viewport:set', { bbox: MOSCOW_VIEW, zoom: 14 });

    ctx.clock.now += PRESENCE.minIntervalMs;
    // та же ячейка и трек, другая позиция в треке — на карте ничего не меняется
    expect((await ask(sb, 'presence:update', update(cellAt(MOSCOW), { positionSec: 42 }))).ok).toBe(true);
    await sleep(PRESENCE.batchMs + 300);
    expect(mentions(deltas, boris.me.id)).toBe(false);

    ctx.clock.now += PRESENCE.minIntervalMs;
    expect((await ask(sb, 'presence:update', update(cellAt(MOSCOW), { track: track('jamendo:77') }))).ok).toBe(true);
    const seen = await waitFor(() => upsertOf(deltas, boris.me.id));
    expect(seen.track?.id).toBe('jamendo:77');
  });

  it('approx: B публикует квартал с approx=true — A видит флаг в дельте и в /nearby; смену режима рассылают, даже если точка та же', async () => {
    const sa = await open(alice.token);
    const sb = await open(boris.token);
    const deltas = collectDeltas(sa);
    ctx.clock.now += 1_000;
    await ask(sa, 'viewport:set', { bbox: MOSCOW_VIEW, zoom: 14 });

    // так ячейку строит клиент в приблизительном режиме: центр квартала, а не точка человека
    const zoneCell = approxCell(MOSCOW.lat, MOSCOW.lng);
    ctx.clock.now += PRESENCE.minIntervalMs;
    expect((await ask(sb, 'presence:update', update(zoneCell, { approx: true }))).ok).toBe(true);
    const seen = await waitFor(() => upsertOf(deltas, boris.me.id));
    expect(seen.approx).toBe(true);
    // точка отображения лежит внутри квартала — по ней клиент A восстанавливает зону
    expect(approxBlockBBox(seen.lat, seen.lng)).toEqual(approxBlockBBox(MOSCOW.lat, MOSCOW.lng));

    const nearby = await get(`/v1/presence/nearby?bbox=${bboxParam(MOSCOW_VIEW)}&zoom=14`, alice.token);
    const listed = (nearby.json() as { users: PresenceView[] }).users.find((u) => u.userId === boris.me.id);
    expect(listed?.approx).toBe(true);

    // та же ячейка, режим стал точным: точка не сдвинулась, но A обязан узнать, что зону пора схлопнуть
    deltas.length = 0;
    ctx.clock.now += PRESENCE.minIntervalMs;
    expect((await ask(sb, 'presence:update', update(zoneCell, { approx: false }))).ok).toBe(true);
    const flipped = await waitFor(() => upsertOf(deltas, boris.me.id));
    expect(flipped.approx).toBe(false);
    expect([flipped.lng, flipped.lat]).toEqual([seen.lng, seen.lat]);
  });

  it('невидимку не хранят и не рассылают; «для подписчиков» нет в снимке, дельтах и кластерах', async () => {
    const ghost = await onboardUser(ctx.app, { name: 'Гоша' });
    const teen = await onboardUser(ctx.app, { name: 'Дина' });
    await setVisibility(ghost.me.id, 'ghost');
    await setVisibility(teen.me.id, 'followers');

    const sa = await open(alice.token);
    const deltas = collectDeltas(sa);
    ctx.clock.now += 1_000;
    await ask(sa, 'viewport:set', { bbox: MOSCOW_VIEW, zoom: 14 });

    const [sg, st] = await Promise.all([open(ghost.token), open(teen.token)]);
    expect((await ask(sg, 'presence:update', update(cellAt(MOSCOW)))).ok).toBe(true);
    expect((await ask(st, 'presence:update', update(cellAt(MOSCOW)))).ok).toBe(true);
    await sleep(PRESENCE.batchMs + 300);

    expect(await store.get(ghost.me.id)).toBeNull();
    expect((await store.get(teen.me.id))?.visibility).toBe('followers');
    expect(mentions(deltas, ghost.me.id)).toBe(false);
    expect(mentions(deltas, teen.me.id)).toBe(false);

    const nearby = await get(`/v1/presence/nearby?bbox=${bboxParam(MOSCOW_VIEW)}&zoom=14`, alice.token);
    expect(nearby.statusCode).toBe(200);
    const ids = (nearby.json() as { users: PresenceView[] }).users.map((u) => u.userId);
    expect(ids).toContain(boris.me.id);
    expect(ids).not.toContain(teen.me.id);
    expect(ids).not.toContain(ghost.me.id);

    const clusters = await get(`/v1/presence/clusters?bbox=${bboxParam(MOSCOW_VIEW)}&zoom=10`, alice.token);
    const cells = (clusters.json() as { cells: { count: number }[] }).cells;
    expect(cells.reduce((sum, c) => sum + c.count, 0)).toBe(1); // только Борис
  });

  it('зум 10 — режим кластеров: без комнат и без точек', async () => {
    const sa = await open(alice.token);
    const sb = await open(boris.token);
    const deltas = collectDeltas(sa);
    ctx.clock.now += 1_000;
    const live = await ask<ViewportAck>(sa, 'viewport:set', { bbox: MOSCOW_VIEW, zoom: 14 });
    expect(live.ok && live.data.mode).toBe('live');
    const coarse = await ask<ViewportAck>(sa, 'viewport:set', { bbox: MOSCOW_VIEW, zoom: 10 });
    expect(coarse).toEqual({ ok: true, data: { mode: 'clusters', rooms: 0, users: [] } });

    // комнаты покинуты: изменения Бориса больше не приходят
    ctx.clock.now += PRESENCE.minIntervalMs;
    expect((await ask(sb, 'presence:update', update(cellAt(MOSCOW), { track: track('archive:zoom10') }))).ok).toBe(true);
    await sleep(PRESENCE.batchMs + 300);
    expect(mentions(deltas, boris.me.id)).toBe(false);

    const nearby = await get(`/v1/presence/nearby?bbox=${bboxParam(MOSCOW_VIEW)}&zoom=10`, alice.token);
    expect(nearby.json()).toEqual({ users: [] });
  });

  it('GET /clusters считает по ячейкам нужной точности', async () => {
    const base = cellAt(MOSCOW).slice(0, 5);
    const [w, s, e, n] = decodeGeohashBBox(base);
    const sameCell = encodeGeohash(s + (n - s) * 0.3, w + (e - w) * 0.3, 7);
    const northCell = encodeGeohash(n + (n - s) * 0.5, w + (e - w) * 0.5, 7);
    const u1 = await onboardUser(ctx.app, { name: 'Ева' });
    const u2 = await onboardUser(ctx.app, { name: 'Жора' });
    for (const [u, cell] of [
      [u1, sameCell],
      [u2, northCell],
    ] as const) {
      const res = await ctx.app.inject({ method: 'POST', url: '/v1/presence', headers: bearer(u.token), payload: update(cell) });
      expect(res.statusCode).toBe(204);
    }
    const bbox: BBox = [w - 0.1, s - 0.1, e + 0.1, n + 0.1];
    const res = await get(`/v1/presence/clusters?bbox=${bboxParam(bbox)}&zoom=10`, alice.token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { precision: number; cells: { cell: string; count: number }[] };
    expect(body.precision).toBe(5);
    expect(body.cells.map((c) => [c.cell, c.count])).toEqual([
      [base, 2], // Борис + Ева
      [northCell.slice(0, 5), 1],
    ]);
    const p3 = (await get(`/v1/presence/clusters?bbox=${bboxParam(bbox)}&zoom=5`, alice.token)).json() as {
      precision: number;
      cells: { count: number }[];
    };
    expect(p3.precision).toBe(3);
    expect(p3.cells.reduce((sum, c) => sum + c.count, 0)).toBe(3);
  });

  it('HTTP: обновление и heartbeat; heartbeat без точки — 404; лимит heartbeat', async () => {
    const u = await onboardUser(ctx.app, { name: 'Зоя' });
    const headers = bearer(u.token);
    const hb = { track: track('jamendo:5'), playing: false, positionSec: 3 };

    const missing = await ctx.app.inject({ method: 'POST', url: '/v1/presence/heartbeat', headers, payload: hb });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('presence_not_found');

    const raw = await ctx.app.inject({
      method: 'POST',
      url: '/v1/presence',
      headers,
      payload: { lat: MOSCOW.lat, lng: MOSCOW.lng, motion: 'still', approx: false, track: null, playing: false, positionSec: null },
    });
    expect(raw.statusCode).toBe(400);

    const up = await ctx.app.inject({ method: 'POST', url: '/v1/presence', headers, payload: update(cellAt(MOSCOW)) });
    expect(up.statusCode).toBe(204);
    const before = (await store.get(u.me.id))!;

    ctx.clock.now += 30_000;
    const ok = await ctx.app.inject({ method: 'POST', url: '/v1/presence/heartbeat', headers, payload: hb });
    expect(ok.statusCode).toBe(204);
    const after = (await store.get(u.me.id))!;
    expect(after.seenAt).toBe(before.seenAt + 30_000);
    expect(after.positionAt).toBe(before.positionAt);
    expect(after.cell).toBe(before.cell);
    expect(after.track?.id).toBe('jamendo:5');

    // 2 уже было, лимит 6 в минуту
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await ctx.app.inject({ method: 'POST', url: '/v1/presence/heartbeat', headers, payload: hb })).statusCode);
    }
    expect(codes).toEqual([204, 204, 204, 204, 429]);
  });

  it('HTTP: без онбординга — 403, без токена — 401', async () => {
    const fresh = await authDevice(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/presence',
      headers: bearer(fresh.accessToken),
      payload: update(cellAt(MOSCOW)),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('onboarding_required');
    const anon = await ctx.app.inject({ method: 'GET', url: `/v1/presence/nearby?bbox=${bboxParam(MOSCOW_VIEW)}&zoom=14` });
    expect(anon.statusCode).toBe(401);
  });

  it('чистильщик убирает точку через TTL, и A получает удаление', async () => {
    const sa = await open(alice.token);
    const sb = await open(boris.token);
    const deltas = collectDeltas(sa);
    ctx.clock.now += 1_000;
    await ask(sa, 'viewport:set', { bbox: MOSCOW_VIEW, zoom: 14 });
    ctx.clock.now += PRESENCE.minIntervalMs;
    expect((await ask(sb, 'presence:update', update(cellAt(MOSCOW)))).ok).toBe(true);
    expect(await store.get(boris.me.id)).not.toBeNull();

    ctx.clock.now += PRESENCE.ttlSec * 1000 + 1_000;
    // чистильщик раз в 5 с + пачка раз в секунду
    await waitFor(() => deltas.some((d) => d.removes.includes(boris.me.id)), 8_000);
    expect(await store.get(boris.me.id)).toBeNull();
  });
});

// эти ключи есть в записи и нигде больше: тип следит, чтобы тест выше не отстал от store.ts
const _recordKeys: Record<keyof PresenceRecord, true> = {
  userId: true, name: true, mapAvatarUrl: true, visibility: true, cell: true, displayCell: true, lng: true, lat: true,
  motion: true, approx: true, track: true, playing: true, positionSec: true, positionAt: true, seenAt: true,
};
void _recordKeys;
