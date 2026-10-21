import { randomBytes } from 'node:crypto';
import { AvatarUploadResponse } from '@muzradar/shared';
import { count, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { avatars, users } from '../src/db/schema.ts';
import { processAvatar } from '../src/modules/me/avatar.ts';
import { HttpError } from '../src/plugins/errors.ts';
import { authDevice, bearer, consentsPayload, createTestContext, sampleAvatarBase64, type TestContext } from './helpers.ts';

async function expectBadImage(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ statusCode: 422, code: 'bad_image' });
}

/** Слева красное, справа синее; EXIF orientation=6 — «поверни на 90° по часовой». */
async function rotatedJpegBase64(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="225">
    <rect width="150" height="225" fill="#ff0000"/><rect x="150" width="150" height="225" fill="#0000ff"/></svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  return jpeg.toString('base64');
}

describe('processAvatar', () => {
  it('JPEG → мастер 128×128 WebP без EXIF и альфы, карта 96×96 с прозрачными углами', async () => {
    const out = await processAvatar(await sampleAvatarBase64());
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);

    const master = await sharp(out.webp).metadata();
    expect(master).toMatchObject({ format: 'webp', width: 128, height: 128, channels: 3, hasAlpha: false });
    expect(master.exif).toBeUndefined();
    expect(master.icc).toBeUndefined();
    expect(master.xmp).toBeUndefined();

    const map = await sharp(out.mapWebp).metadata();
    expect(map).toMatchObject({ format: 'webp', width: 96, height: 96, channels: 4, hasAlpha: true });
    expect(map.exif).toBeUndefined();
    const { data } = await sharp(out.mapWebp).raw().toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * 96 + x) * 4 + 3];
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(95, 95)).toBe(0);
    expect(alpha(48, 48)).toBe(255);
  });

  it('учитывает EXIF-ориентацию до кропа', async () => {
    const out = await processAvatar(await rotatedJpegBase64());
    const { data } = await sharp(out.webp).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.subarray((y * 128 + x) * 3, (y * 128 + x) * 3 + 3));
    const [topR, , topB] = px(64, 8);
    const [bottomR, , bottomB] = px(64, 120);
    // После поворота красная половина сверху, синяя снизу.
    expect(topR!).toBeGreaterThan(200);
    expect(topB!).toBeLessThan(60);
    expect(bottomB!).toBeGreaterThan(200);
    expect(bottomR!).toBeLessThan(60);
  });

  it('отклоняет PNG, мусор, обрезанный JPEG и слишком большие стороны', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } }).png().toBuffer();
    await expectBadImage(processAvatar(png.toString('base64')));
    await expectBadImage(processAvatar(randomBytes(900).toString('base64')));
    await expectBadImage(processAvatar(''));

    const jpeg = Buffer.from(await sampleAvatarBase64(), 'base64');
    await expectBadImage(processAvatar(jpeg.subarray(0, jpeg.length - 300).toString('base64')));

    const wide = await sharp({ create: { width: 1100, height: 200, channels: 3, background: '#888' } })
      .jpeg({ quality: 10 })
      .toBuffer();
    await expectBadImage(processAvatar(wide.toString('base64')));
  });
});

describe('аватары через API', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** Аватар принимается только после согласий. */
  async function consentedUser() {
    const auth = await authDevice(ctx.app);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/me/consents',
      headers: bearer(auth.accessToken),
      payload: consentsPayload(2000),
    });
    expect(res.statusCode).toBe(200);
    return auth;
  }

  function upload(token: string, imageBase64: string) {
    return ctx.app.inject({ method: 'PUT', url: '/v1/me/avatar', headers: bearer(token), payload: { imageBase64 } });
  }

  const avatarRows = async () => (await ctx.app.db.select({ n: count() }).from(avatars))[0]!.n;

  let uploadedHash = '';

  it('валидный JPEG → 200; в БД мастер 128×128 WebP без EXIF и круглая версия 96×96 с альфой', async () => {
    const auth = await consentedUser();
    const res = await upload(auth.accessToken, await sampleAvatarBase64());
    expect(res.statusCode).toBe(200);
    const body = AvatarUploadResponse.parse(res.json());
    const hash = /^\/v1\/avatars\/([0-9a-f]{64})\.webp$/.exec(body.avatarUrl)?.[1];
    expect(hash).toBeDefined();
    expect(body.mapAvatarUrl).toBe(`/v1/avatars/${hash}/map.webp`);
    uploadedHash = hash!;

    const [row] = await ctx.app.db.select().from(avatars).where(eq(avatars.hash, uploadedHash));
    expect(row?.bytes).toBe(body.bytes);
    expect(row?.webp.length).toBe(body.bytes);

    const master = await sharp(row!.webp).metadata();
    expect(master).toMatchObject({ format: 'webp', width: 128, height: 128 });
    expect(master.exif).toBeUndefined();
    const map = await sharp(row!.mapWebp).metadata();
    expect(map).toMatchObject({ format: 'webp', width: 96, height: 96, channels: 4 });

    const [user] = await ctx.app.db.select().from(users).where(eq(users.id, auth.me.id));
    expect(user?.avatarHash).toBe(uploadedHash);
  });

  it('PNG и мусор → 422 bad_image; не-base64 → 400', async () => {
    const auth = await consentedUser();
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } }).png().toBuffer();
    const pngRes = await upload(auth.accessToken, png.toString('base64'));
    expect(pngRes.statusCode).toBe(422);
    expect(pngRes.json()).toMatchObject({ error: 'bad_image' });

    const garbage = await upload(auth.accessToken, randomBytes(600).toString('base64'));
    expect(garbage.statusCode).toBe(422);

    const notBase64 = await upload(auth.accessToken, 'это не base64!');
    expect(notBase64.statusCode).toBe(400);
  });

  it('слишком большое тело → 413, больше лимита схемы → 400', async () => {
    const auth = await consentedUser();
    const huge = await upload(auth.accessToken, 'A'.repeat(30_000));
    expect(huge.statusCode).toBe(413);
    const overSchema = await upload(auth.accessToken, 'A'.repeat(20_000));
    expect(overSchema.statusCode).toBe(400);
  });

  it('одинаковые байты хранятся одной строкой', async () => {
    const image = await sampleAvatarBase64();
    const a = await consentedUser();
    const b = await consentedUser();
    const before = await avatarRows();
    for (const token of [a.accessToken, a.accessToken, b.accessToken]) {
      expect((await upload(token, image)).statusCode).toBe(200);
    }
    // Тот же снимок уже загружен первым тестом — новых строк нет вовсе.
    expect(await avatarRows()).toBe(before);
    const hashes = await ctx.app.db.select({ h: users.avatarHash }).from(users).where(eq(users.id, b.me.id));
    expect(hashes[0]?.h).toBe(uploadedHash);
  });

  it('лимит 5 загрузок в минуту на пользователя', async () => {
    const auth = await consentedUser();
    const image = await sampleAvatarBase64(200);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await upload(auth.accessToken, image)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  describe('GET /v1/avatars', () => {
    it('отдаёт WebP с immutable-кэшем и ETag', async () => {
      const [row] = await ctx.app.db.select().from(avatars).where(eq(avatars.hash, uploadedHash));
      const res = await ctx.app.inject({ method: 'GET', url: `/v1/avatars/${uploadedHash}.webp` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers.etag).toBe(`"${uploadedHash}"`);
      expect(res.rawPayload.equals(row!.webp)).toBe(true);

      const map = await ctx.app.inject({ method: 'GET', url: `/v1/avatars/${uploadedHash}/map.webp` });
      expect(map.statusCode).toBe(200);
      expect(map.headers['content-type']).toBe('image/webp');
      expect(map.headers.etag).toBe(`"${uploadedHash}"`);
      expect(map.rawPayload.equals(row!.mapWebp)).toBe(true);
    });

    it('If-None-Match → 304 без тела', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/v1/avatars/${uploadedHash}.webp`,
        headers: { 'if-none-match': `W/"other", "${uploadedHash}"` },
      });
      expect(res.statusCode).toBe(304);
      expect(res.headers.etag).toBe(`"${uploadedHash}"`);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.rawPayload.length).toBe(0);
    });

    it('неизвестный хеш → 404, кривой адрес → 400', async () => {
      const unknown = 'f'.repeat(64);
      for (const url of [`/v1/avatars/${unknown}.webp`, `/v1/avatars/${unknown}/map.webp`]) {
        const res = await ctx.app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: 'avatar_not_found' });
      }
      const conditional = await ctx.app.inject({
        method: 'GET',
        url: `/v1/avatars/${unknown}.webp`,
        headers: { 'if-none-match': `"${unknown}"` },
      });
      expect(conditional.statusCode).toBe(404);

      for (const url of [
        '/v1/avatars/xyz.webp',
        `/v1/avatars/${uploadedHash.toUpperCase()}.webp`,
        `/v1/avatars/${uploadedHash}.png`,
        `/v1/avatars/${uploadedHash}`,
        `/v1/avatars/${uploadedHash.slice(1)}/map.webp`,
      ]) {
        const res = await ctx.app.inject({ method: 'GET', url });
        expect([400, 404]).toContain(res.statusCode);
      }
    });
  });
});
