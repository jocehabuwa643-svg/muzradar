import {
  GEO_PRECISION,
  PRESENCE,
  REALTIME_PATH,
  encodeGeohash,
  type AckResult,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type ViewportAck,
} from '@muzradar/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryPresenceStore } from '../src/modules/presence/memory.ts';
import { authDevice, createTestContext, onboardUser, type TestContext } from './helpers.ts';

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

function ask<T = null>(socket: ClientSocket, event: keyof ClientToServerEvents, ...args: unknown[]): Promise<AckResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет ack на ${event}`)), 5_000);
    (socket.emit as unknown as (ev: string, ...rest: unknown[]) => void)(event, ...args, (res: AckResult<T>) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

const MOSCOW_CELL = encodeGeohash(55.7558, 37.6173, GEO_PRECISION.client);
const update = { cell: MOSCOW_CELL, motion: 'still', approx: false, track: null, playing: false, positionSec: null };
const viewport = { bbox: [37.58, 55.735, 37.65, 55.775], zoom: 14 };

describe('реалтайм: вход и лимиты', () => {
  let ctx: TestContext;
  const sockets: ClientSocket[] = [];
  let token: string;

  beforeAll(async () => {
    ctx = await createTestContext({ presence: new MemoryPresenceStore(), listen: true });
    token = (await onboardUser(ctx.app, { name: 'Лимит' })).token;
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await ctx?.close();
  });

  it('плохой токен → unauthorized', async () => {
    await expect(openSocket(ctx.baseUrl!, 'garbage')).rejects.toThrow('unauthorized');
  });

  it('токен без онбординга → onboarding_required', async () => {
    const auth = await authDevice(ctx.app);
    await expect(openSocket(ctx.baseUrl!, auth.accessToken)).rejects.toThrow('onboarding_required');
  });

  it('кривые данные → bad_payload; координаты вместо ячейки не принимаются', async () => {
    const s = await openSocket(ctx.baseUrl!, token);
    sockets.push(s);
    expect(await ask(s, 'presence:update', { ...update, cell: 'ucfv0j' })).toEqual({ ok: false, error: 'bad_payload' });
    expect(await ask(s, 'presence:update', { lat: 55.75, lng: 37.61, motion: 'still' })).toEqual({ ok: false, error: 'bad_payload' });
    expect(await ask(s, 'presence:heartbeat', { playing: 'yes' })).toEqual({ ok: false, error: 'bad_payload' });
    expect(await ask(s, 'viewport:set', { bbox: [40, 50, 30, 60], zoom: 14 })).toEqual({ ok: false, error: 'bad_payload' });
    expect(await ask(s, 'viewport:set', 'nope')).toEqual({ ok: false, error: 'bad_payload' });
  });

  it('обновление не чаще раза в 5 с, heartbeat — раза в 20 с, вьюпорт — 2 в секунду', async () => {
    const s = await openSocket(ctx.baseUrl!, token);
    sockets.push(s);

    expect(await ask(s, 'presence:update', update)).toEqual({ ok: true, data: null });
    expect(await ask(s, 'presence:update', update)).toEqual({ ok: false, error: 'rate_limited' });
    ctx.clock.now += PRESENCE.minIntervalMs;
    expect(await ask(s, 'presence:update', update)).toEqual({ ok: true, data: null });

    const hb = { track: null, playing: false, positionSec: null };
    expect(await ask(s, 'presence:heartbeat', hb)).toEqual({ ok: true, data: null });
    ctx.clock.now += 10_000;
    expect(await ask(s, 'presence:heartbeat', hb)).toEqual({ ok: false, error: 'rate_limited' });
    ctx.clock.now += 10_000;
    expect(await ask(s, 'presence:heartbeat', hb)).toEqual({ ok: true, data: null });

    expect((await ask<ViewportAck>(s, 'viewport:set', viewport)).ok).toBe(true);
    expect((await ask<ViewportAck>(s, 'viewport:set', viewport)).ok).toBe(true);
    expect(await ask(s, 'viewport:set', viewport)).toEqual({ ok: false, error: 'rate_limited' });
    ctx.clock.now += 1_000;
    expect((await ask<ViewportAck>(s, 'viewport:set', viewport)).ok).toBe(true);
  });

  it('heartbeat без живой точки → not_found (нужно полное обновление)', async () => {
    const other = await onboardUser(ctx.app, { name: 'Пустой' });
    const s = await openSocket(ctx.baseUrl!, other.token);
    sockets.push(s);
    expect(await ask(s, 'presence:heartbeat', { track: null, playing: true, positionSec: 1 })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('событие без ack не роняет обработчик', async () => {
    const s = await openSocket(ctx.baseUrl!, token);
    sockets.push(s);
    (s.emit as unknown as (ev: string, ...rest: unknown[]) => void)('presence:update', update, 123);
    s.emit('viewport:set', { bbox: [37.58, 55.735, 37.65, 55.775], zoom: 14 });
    ctx.clock.now += 1_000;
    // сокет жив и отвечает
    expect((await ask<ViewportAck>(s, 'viewport:set', viewport)).ok).toBe(true);
  });
});
