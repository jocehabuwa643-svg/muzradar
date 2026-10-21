import { LEGAL_VERSIONS, Me, SessionResponse } from '@muzradar/shared';
import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consents, users } from '../src/db/schema.ts';
import { resolveVisibility } from '../src/modules/me/consents.ts';
import { checkName } from '../src/modules/me/names.ts';
import {
  authDevice,
  bearer,
  consentsPayload,
  createTestContext,
  onboardUser,
  sampleAvatarBase64,
  sampleProfile,
  type TestContext,
} from './helpers.ts';

describe('фильтр имён', () => {
  it.each([
    'Хуй',
    'xyй', // латинские x и y
    'П и з д а',
    'f.u.c.k',
    'FuCk_you',
    'Бляяядь',
    'Ёбаный',
    'Admin',
    'аdmin', // кириллическая «а»
    'adm1n',
    'Модератор',
    'MUZRADAR',
    'muz radar',
    'Музрадар 2',
    'support.team',
  ])('отклоняет «%s»', (name) => {
    expect(checkName(name)).not.toBeNull();
  });

  it.each(['Тест', 'Глеб', 'Глеб Анатольевич', 'Аманда', 'Asuka', 'Xue Li', 'Nguyen Huy', 'Анна-Мария', 'Сергей', 'DJ Radar'])(
    'пропускает «%s»',
    (name) => {
      expect(checkName(name)).toBeNull();
    },
  );

  it('различает мат и зарезервированные слова', () => {
    expect(checkName('Хуй')).toBe('obscene');
    expect(checkName('Администратор')).toBe('reserved');
  });
});

describe('видимость по согласиям и возрасту', () => {
  const now = new Date('2026-09-18T12:00:00Z');
  const full = ['name', 'avatar', 'track', 'location'] as const;
  it.each([
    [2000, full, 'public'],
    [2008, full, 'public'],
    [2009, full, 'followers'],
    [2010, full, 'followers'],
    [2000, ['track'], 'ghost'],
    [2000, ['name', 'avatar', 'track'], 'ghost'],
    [2010, ['name', 'track'], 'ghost'],
  ] as const)('%i, %j → %s', (year, scope, expected) => {
    expect(resolveVisibility(year, scope, now)).toBe(expected);
  });
});

describe('/v1/me', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const year = () => new Date(ctx.clock.now).getUTCFullYear();

  async function putConsents(token: string, payload: InjectOptions['payload']) {
    return ctx.app.inject({ method: 'PUT', url: '/v1/me/consents', headers: bearer(token), payload });
  }

  async function putProfile(token: string, payload: InjectOptions['payload'] = sampleProfile) {
    return ctx.app.inject({ method: 'PUT', url: '/v1/me/profile', headers: bearer(token), payload });
  }

  async function putAvatar(token: string) {
    return ctx.app.inject({
      method: 'PUT',
      url: '/v1/me/avatar',
      headers: bearer(token),
      payload: { imageBase64: await sampleAvatarBase64() },
    });
  }

  describe('PUT /v1/me/consents', () => {
    it('2000 год, полный scope → public; три строки журнала с IP и устройством', async () => {
      const auth = await authDevice(ctx.app);
      const res = await putConsents(auth.accessToken, consentsPayload(2000));
      expect(res.statusCode).toBe(200);
      const me = Me.parse(res.json());
      expect(me).toMatchObject({ birthYear: 2000, visibility: 'public', consentsVersion: LEGAL_VERSIONS.processing });

      const rows = await ctx.app.db.select().from(consents).where(eq(consents.userId, auth.me.id));
      expect(rows.map((r) => r.kind).sort()).toEqual(['dissemination', 'processing', 'rules']);
      const did = ctx.app.verifyAccessToken(auth.accessToken).did;
      for (const row of rows) {
        expect(row.ip).toBe('127.0.0.1');
        expect(row.deviceId).toBe(did);
        expect(row.version).toBe(LEGAL_VERSIONS[row.kind]);
        expect(row.recordedAt.getTime()).toBe(ctx.clock.now);
      }
      const dissemination = rows.find((r) => r.kind === 'dissemination');
      expect(dissemination?.scope).toEqual(['name', 'avatar', 'track', 'location']);
      expect(rows.find((r) => r.kind === 'processing')?.scope).toBeNull();
    });

    it('15 лет → 403 age_restricted, год рождения не сохраняется', async () => {
      const auth = await authDevice(ctx.app);
      const res = await putConsents(auth.accessToken, consentsPayload(year() - 15));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'age_restricted', message: 'МУЗРАДАР доступен с 16 лет' });

      const [user] = await ctx.app.db.select().from(users).where(eq(users.id, auth.me.id));
      expect(user?.birthYear).toBeNull();
      expect(user?.consentsVersion).toBeNull();
      expect(await ctx.app.db.select().from(consents).where(eq(consents.userId, auth.me.id))).toHaveLength(0);
    });

    it('17 лет → followers', async () => {
      const auth = await authDevice(ctx.app);
      const res = await putConsents(auth.accessToken, consentsPayload(year() - 17));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ visibility: 'followers' });
    });

    it('согласие на распространение только трека → ghost (ограниченное согласие принимается)', async () => {
      const auth = await authDevice(ctx.app);
      const payload = consentsPayload(2000);
      const res = await putConsents(auth.accessToken, {
        ...payload,
        consents: { ...payload.consents, dissemination: { ...payload.consents.dissemination, scope: ['track'] } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ visibility: 'ghost' });
    });

    it('устаревшая редакция документа → 409 consents_outdated', async () => {
      const auth = await authDevice(ctx.app);
      const payload = consentsPayload(2000);
      const res = await putConsents(auth.accessToken, {
        ...payload,
        consents: { ...payload.consents, rules: { ...payload.consents.rules, version: '2025-01-01' } },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'consents_outdated' });
    });

    it('год рождения старше 100 лет → 400 bad_birth_year', async () => {
      const auth = await authDevice(ctx.app);
      const res = await putConsents(auth.accessToken, consentsPayload(year() - 101));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'bad_birth_year' });
    });

    it('без токена → 401', async () => {
      const res = await ctx.app.inject({ method: 'PUT', url: '/v1/me/consents', payload: consentsPayload(2000) });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /v1/me', () => {
    it('возвращает профиль; удалённый аккаунт → 401', async () => {
      const auth = await authDevice(ctx.app);
      const ok = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.accessToken) });
      expect(ok.statusCode).toBe(200);
      expect(Me.parse(ok.json()).id).toBe(auth.me.id);

      await ctx.app.db.update(users).set({ deletedAt: new Date(ctx.clock.now) }).where(eq(users.id, auth.me.id));
      const gone = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.accessToken) });
      expect(gone.statusCode).toBe(401);
    });

    it('без токена → 401', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/v1/me' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /v1/me/profile', () => {
    it('до аватара → 409 onboarding_incomplete, missing = [avatar]', async () => {
      const auth = await authDevice(ctx.app);
      expect((await putConsents(auth.accessToken, consentsPayload(2000))).statusCode).toBe(200);
      const res = await putProfile(auth.accessToken);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'onboarding_incomplete', details: { missing: ['avatar'] } });
    });

    it('до согласий → 409, missing = [consents, avatar]; аватар без согласий не принимается', async () => {
      const auth = await authDevice(ctx.app);
      const profile = await putProfile(auth.accessToken);
      expect(profile.statusCode).toBe(409);
      expect(profile.json()).toMatchObject({ details: { missing: ['consents', 'avatar'] } });

      const avatar = await putAvatar(auth.accessToken);
      expect(avatar.statusCode).toBe(409);
      expect(avatar.json()).toMatchObject({ error: 'onboarding_incomplete', details: { missing: ['consents'] } });
    });

    it('запрещённое имя → 422 name_rejected', async () => {
      const auth = await authDevice(ctx.app);
      expect((await putConsents(auth.accessToken, consentsPayload(2000))).statusCode).toBe(200);
      expect((await putAvatar(auth.accessToken)).statusCode).toBe(200);
      for (const name of ['Хуй', 'Admin']) {
        const res = await putProfile(auth.accessToken, { ...sampleProfile, name });
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({ error: 'name_rejected' });
      }
      const dupGenres = await putProfile(auth.accessToken, {
        ...sampleProfile,
        taste: { ...sampleProfile.taste, genres: ['pop', 'pop', 'pop'] },
      });
      expect(dupGenres.statusCode).toBe(400);
      expect(dupGenres.json()).toMatchObject({ error: 'bad_taste' });
    });

    it('полный флоу → токен с ob=true и onboardedAt; повторный PUT не сдвигает onboardedAt', async () => {
      const { token, me } = await onboardUser(ctx.app, { name: 'Глеб' });
      const claims = ctx.app.verifyAccessToken(token);
      expect(claims.ob).toBe(true);
      expect(claims.sub).toBe(me.id);
      expect(me.onboardedAt).toBe(new Date(ctx.clock.now).toISOString());
      expect(me).toMatchObject({ name: 'Глеб', visibility: 'public', taste: sampleProfile.taste });
      expect(me.avatarUrl).toMatch(/^\/v1\/avatars\/[0-9a-f]{64}\.webp$/);
      expect(me.mapAvatarUrl).toMatch(/^\/v1\/avatars\/[0-9a-f]{64}\/map\.webp$/);

      const firstOnboardedAt = me.onboardedAt;
      ctx.clock.now += 60_000;
      const res = await putProfile(token, { ...sampleProfile, name: 'Глеб Анатольевич' });
      expect(res.statusCode).toBe(200);
      const session = SessionResponse.parse(res.json());
      expect(session.me.name).toBe('Глеб Анатольевич');
      expect(session.me.onboardedAt).toBe(firstOnboardedAt);

      const fresh = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(session.accessToken) });
      expect(Me.parse(fresh.json()).onboardedAt).toBe(firstOnboardedAt);
    });
  });
});
