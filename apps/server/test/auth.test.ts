import { DeviceAuthResponse } from '@muzradar/shared';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { devices, users } from '../src/db/schema.ts';
import { hmacHex, newDeviceId, newUserId, sha256Hex } from '../src/ids.ts';
import { authenticateDevice } from '../src/modules/auth/service.ts';
import { authDevice, createTestContext, newInstallSecret, type TestContext } from './helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx?.close();
});

const deviceBySecret = async (secret: string) => {
  const [row] = await ctx.app.db.select().from(devices).where(eq(devices.secretHash, sha256Hex(secret)));
  return row;
};

const userCount = async () => {
  const [row] = await ctx.app.db.select({ n: count() }).from(users);
  return row!.n;
};

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('POST /v1/auth/device', () => {
  it('создаёт аккаунт для нового секрета', async () => {
    const res = await authDevice(ctx.app, { platform: 'android', appVersion: '0.1.0' });
    expect(res.isNew).toBe(true);
    expect(res.restored).toBe(false);
    expect(res.me.onboardedAt).toBeNull();
    expect(res.me.consentsVersion).toBeNull();
    expect(res.me.visibility).toBe('public');
  });

  it('тот же секрет — тот же аккаунт, не новый; IP пишется только как lastIp', async () => {
    const secret = newInstallSecret();
    const first = await authDevice(ctx.app, { installSecret: secret });
    ctx.clock.now += 5_000;
    const second = await authDevice(ctx.app, { installSecret: secret, appVersion: '0.1.1' });
    expect(second.isNew).toBe(false);
    expect(second.restored).toBe(false);
    expect(second.me.id).toBe(first.me.id);

    const device = await deviceBySecret(secret);
    expect(device?.appVersion).toBe('0.1.1');
    expect(device?.lastIp).toBe('127.0.0.1');
    expect(device?.lastSeenAt.getTime()).toBe(ctx.clock.now);
  });

  it('Android: переустановка с тем же deviceHint восстанавливает аккаунт, старый секрет отозван', async () => {
    const hint = 'a1b2c3d4e5f60718';
    const oldSecret = newInstallSecret();
    const first = await authDevice(ctx.app, { installSecret: oldSecret, platform: 'android', deviceHint: hint });
    expect(first.isNew).toBe(true);

    const oldDevice = await deviceBySecret(oldSecret);
    // Сырой Android ID не хранится — только HMAC с перцем.
    expect(oldDevice?.hintHmac).toBe(hmacHex(ctx.config.androidIdPepper, hint));
    expect(JSON.stringify(oldDevice)).not.toContain(hint);

    const newSecret = newInstallSecret();
    const restored = await authDevice(ctx.app, {
      installSecret: newSecret,
      platform: 'android',
      deviceHint: hint.toUpperCase(),
    });
    expect(restored.restored).toBe(true);
    expect(restored.isNew).toBe(false);
    expect(restored.me.id).toBe(first.me.id);

    const revoked = await ctx.app.db.select().from(devices).where(eq(devices.id, oldDevice!.id));
    expect(revoked[0]?.revokedAt).not.toBeNull();

    // Новый секрет дальше работает как обычный вход.
    const again = await authDevice(ctx.app, { installSecret: newSecret, platform: 'android', deviceHint: hint });
    expect(again).toMatchObject({ isNew: false, restored: false });
    expect(again.me.id).toBe(first.me.id);

    // Старый секрет принадлежит отозванному устройству: он больше ничего не открывает.
    const before = await userCount();
    const stale = await authDevice(ctx.app, { installSecret: oldSecret, platform: 'android' });
    expect(stale.isNew).toBe(true);
    expect(stale.restored).toBe(false);
    expect(stale.me.id).not.toBe(first.me.id);
    expect(await userCount()).toBe(before + 1);

    // Отозванная запись освободила секрет и осталась отозванной.
    const [released] = await ctx.app.db.select().from(devices).where(eq(devices.id, oldDevice!.id));
    expect(released?.revokedAt).not.toBeNull();
    expect(released?.secretHash).not.toBe(sha256Hex(oldSecret));
    expect(await deviceBySecret(oldSecret)).toMatchObject({ userId: stale.me.id, revokedAt: null });
  });

  it('iOS: новый секрет без hint — новый аккаунт; hint на iOS не восстанавливает Android-аккаунт', async () => {
    const hint = '0f1e2d3c4b5a6978';
    const android = await authDevice(ctx.app, { platform: 'android', deviceHint: hint });

    const a = await authDevice(ctx.app, { platform: 'ios' });
    const b = await authDevice(ctx.app, { platform: 'ios' });
    expect(a.isNew && b.isNew).toBe(true);
    expect(a.me.id).not.toBe(b.me.id);

    const ios = await authDevice(ctx.app, { platform: 'ios', deviceHint: hint });
    expect(ios.isNew).toBe(true);
    expect(ios.restored).toBe(false);
    expect(ios.me.id).not.toBe(android.me.id);
  });

  it('deviceHint, похожий на IP, отклоняется схемой', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/device',
      payload: { installSecret: newInstallSecret(), platform: 'android', appVersion: '0.1.0', deviceHint: '192.168.1.10' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation' });
  });

  it('JWT: exp − iat = accessTokenTtlSec, claims sub/did/ob', async () => {
    const res = await authDevice(ctx.app);
    const claims = decodeJwt(res.accessToken);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(ctx.config.accessTokenTtlSec);
    expect(res.expiresInSec).toBe(ctx.config.accessTokenTtlSec);
    expect(claims.sub).toBe(res.me.id);
    expect(claims.ob).toBe(false);
    expect(String(claims.did)).toMatch(/^d_[0-9a-z]{20}$/);
    expect(ctx.app.verifyAccessToken(res.accessToken).sub).toBe(res.me.id);
  });

  it('гонка: 5 одновременных первых запросов с одним секретом → ровно один аккаунт', async () => {
    const secret = newInstallSecret();
    const before = await userCount();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/device',
          payload: { installSecret: secret, platform: 'android', appVersion: '0.1.0' },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    const bodies = responses.map((r) => DeviceAuthResponse.parse(r.json()));
    expect(new Set(bodies.map((b) => b.me.id)).size).toBe(1);
    expect(bodies.filter((b) => b.isNew)).toHaveLength(1);
    expect(await userCount()).toBe(before + 1);
    const rows = await ctx.app.db.select().from(devices).where(eq(devices.secretHash, sha256Hex(secret)));
    expect(rows).toHaveLength(1);
  });

  it('гонка между нодами: проигравший по уникальному индексу становится входом (a), лишний аккаунт откатывается', async () => {
    const secret = newInstallSecret();
    const competitorId = newUserId();
    const db = ctx.app.db;
    let raced = false;
    // «Другая нода» вставляет устройство ровно между поиском (a) и транзакцией создания аккаунта.
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction' && !raced) {
          return async (...args: Parameters<Db['transaction']>) => {
            raced = true;
            await target.insert(users).values({ id: competitorId });
            await target.insert(devices).values({
              id: newDeviceId(),
              userId: competitorId,
              secretHash: sha256Hex(secret),
              platform: 'android',
              appVersion: '0.1.0',
            });
            return target.transaction(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const before = await userCount();
    const session = await authenticateDevice(
      { installSecret: secret, platform: 'android', appVersion: '0.1.0' },
      { db: racingDb, config: ctx.config, now: new Date(ctx.clock.now), ip: '127.0.0.1' },
    );
    expect(raced).toBe(true);
    expect(session).toMatchObject({ isNew: false, restored: false });
    expect(session.user.id).toBe(competitorId);
    // +1 — только аккаунт «другой ноды»: пользователь из откатившейся транзакции не остался.
    expect(await userCount()).toBe(before + 1);
  });
});
