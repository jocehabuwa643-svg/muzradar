import {
  GEO_PRECISION,
  PRESENCE,
  REALTIME_PATH,
  encodeGeohash,
  type AckResult,
  type ClientToServerEvents,
  type ListenState,
  type PresenceUpdate,
  type ServerToClientEvents,
  type TrackRef,
} from '@muzradar/shared';
import { eq } from 'drizzle-orm';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.ts';
import { MemoryPresenceStore } from '../src/modules/presence/memory.ts';
import { createTestContext, onboardUser, type TestContext } from './helpers.ts';

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
const CELL = encodeGeohash(55.7558, 37.6173, GEO_PRECISION.client);
const track = (id: string): TrackRef => ({ id, title: 'Трек', artist: 'Артист', artworkUrl: null, playback: 'full' });
const update = (over: Partial<PresenceUpdate> = {}): PresenceUpdate => ({
  cell: CELL,
  motion: 'still',
  approx: false,
  track: track('audius:first'),
  playing: true,
  positionSec: 5,
  ...over,
});

describe('слушать вместе', () => {
  let ctx: TestContext;
  const sockets: ClientSocket[] = [];
  let listener: Awaited<ReturnType<typeof onboardUser>>;
  let host: Awaited<ReturnType<typeof onboardUser>>;
  let sl: ClientSocket;
  let sh: ClientSocket;
  const states: ListenState[] = [];

  const open = async (token: string) => {
    const s = await openSocket(ctx.baseUrl!, token);
    sockets.push(s);
    return s;
  };

  beforeAll(async () => {
    ctx = await createTestContext({ presence: new MemoryPresenceStore(), listen: true });
    listener = await onboardUser(ctx.app, { name: 'Слушатель' });
    host = await onboardUser(ctx.app, { name: 'Ведущий' });
    sl = await open(listener.token);
    sh = await open(host.token);
    sl.on('listen:state', (s) => states.push(s));
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await ctx?.close();
  });

  it('нельзя присоединиться к тому, кого нет на карте, и к кривому id', async () => {
    expect(await ask(sl, 'listen:join', { userId: host.me.id })).toEqual({ ok: false, error: 'not_available' });
    expect(await ask(sl, 'listen:join', { userId: 'nobody' })).toEqual({ ok: false, error: 'bad_payload' });
  });

  it('join отдаёт текущее состояние, смена трека приходит как listen:state', async () => {
    expect((await ask(sh, 'presence:update', update())).ok).toBe(true);

    const joined = await ask<ListenState>(sl, 'listen:join', { userId: host.me.id });
    expect(joined).toEqual({
      ok: true,
      data: { userId: host.me.id, track: track('audius:first'), playing: true, positionSec: 5, at: ctx.clock.now },
    });

    ctx.clock.now += PRESENCE.minIntervalMs;
    expect((await ask(sh, 'presence:update', update({ track: track('jamendo:second'), positionSec: 0 }))).ok).toBe(true);
    const next = await waitFor(() => states.find((s) => s.track?.id === 'jamendo:second'));
    expect(next).toEqual({ userId: host.me.id, track: track('jamendo:second'), playing: true, positionSec: 0, at: ctx.clock.now });

    // пауза через heartbeat — тоже состояние
    ctx.clock.now += 1_000;
    expect((await ask(sh, 'presence:heartbeat', { track: track('jamendo:second'), playing: false, positionSec: 30 })).ok).toBe(true);
    await waitFor(() => states.find((s) => s.playing === false && s.positionSec === 30));
  });

  it('невидимка: точка удаляется, слушатель получает пустое состояние; к невидимке не присоединиться', async () => {
    await ctx.app.db.update(users).set({ visibility: 'ghost' }).where(eq(users.id, host.me.id));
    // кэш профилей живёт минуту; точка — две
    ctx.clock.now += 61_000;
    expect((await ask(sh, 'presence:update', update())).ok).toBe(true);

    const ended = await waitFor(() => states.find((s) => s.track === null));
    expect(ended).toEqual({ userId: host.me.id, track: null, playing: false, positionSec: null, at: ctx.clock.now });
    expect(await ctx.app.presence.get(host.me.id)).toBeNull();

    const s2 = await open(listener.token);
    expect(await ask(s2, 'listen:join', { userId: host.me.id })).toEqual({ ok: false, error: 'not_available' });
  });

  it('listen:leave: после выхода состояния не приходят', async () => {
    await ctx.app.db.update(users).set({ visibility: 'public' }).where(eq(users.id, host.me.id));
    ctx.clock.now += 61_000;
    expect((await ask(sh, 'presence:update', update({ track: track('archive:third') }))).ok).toBe(true);
    // слушатель ещё в комнате: ведущий вернулся — состояние пришло
    await waitFor(() => states.find((s) => s.track?.id === 'archive:third'));

    expect(await ask(sl, 'listen:leave', { userId: host.me.id })).toEqual({ ok: true, data: null });
    const before = states.length;
    ctx.clock.now += PRESENCE.minIntervalMs;
    expect((await ask(sh, 'presence:update', update({ track: track('archive:fourth') }))).ok).toBe(true);
    await sleep(500);
    expect(states.length).toBe(before);
  });
});
