import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  DeviceAuthResponse,
  LEGAL_VERSIONS,
  Me,
  SessionResponse,
  type DeviceAuthRequest,
  type ProfileInput,
} from '@muzradar/shared';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { buildApp, type AppDeps } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import type { PresenceStore } from '../src/modules/presence/store.ts';

let portSeq = 0;

/** Конфиг для тестов: PGlite в памяти на уникальном порту. */
export function testConfig(env: Record<string, string> = {}): Config {
  const port = 56_000 + ((process.pid % 400) * 10 + portSeq++ % 10);
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PGLITE_DIR: 'memory://',
    PGLITE_PORT: String(port),
    ...env,
  });
}

/** Хранилище присутствия, которое ничего не делает — для тестов, где карта не нужна. */
export const noopPresence: PresenceStore = {
  kind: 'memory',
  get: async () => null,
  upsert: async () => undefined,
  heartbeat: async () => null,
  remove: async () => null,
  searchBBox: async () => [],
  clusters: async () => [],
  sweep: async () => [],
  close: async () => undefined,
};

export interface TestContext {
  app: FastifyInstance;
  config: Config;
  database: Database;
  /** Управляемые часы: `app.now()` возвращает `clock.now`. */
  clock: { now: number };
  /** Адрес, если контекст создан с `listen: true`. */
  baseUrl: string | null;
  close(): Promise<void>;
}

export interface TestContextOptions {
  presence?: PresenceStore;
  catalogProviders?: AppDeps['catalogProviders'];
  env?: Record<string, string>;
  /** Поднять настоящий HTTP-сервер (нужно для Socket.IO). */
  listen?: boolean;
}

export async function createTestContext(opts: TestContextOptions = {}): Promise<TestContext> {
  const config = testConfig(opts.env);
  const database = await openDatabase(config);
  const clock = { now: Date.now() };
  const app = await buildApp({
    config,
    database,
    presence: opts.presence ?? noopPresence,
    ...(opts.catalogProviders ? { catalogProviders: opts.catalogProviders } : {}),
    now: () => clock.now,
    logger: false,
  });
  let baseUrl: string | null = null;
  if (opts.listen) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  } else {
    await app.ready();
  }
  return {
    app,
    config,
    database,
    clock,
    baseUrl,
    async close() {
      await app.close();
      await database.close();
    },
  };
}

export function newInstallSecret(): string {
  return randomBytes(32).toString('base64url');
}

export async function authDevice(app: FastifyInstance, body: Partial<DeviceAuthRequest> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/device',
    payload: { installSecret: newInstallSecret(), platform: 'android', appVersion: '0.1.0', ...body },
  });
  if (res.statusCode !== 200) throw new Error(`auth/device ${res.statusCode}: ${res.body}`);
  return DeviceAuthResponse.parse(res.json());
}

export function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Небольшой JPEG «с лицом» условно: для сервера важен только формат и размер. */
export async function sampleAvatarBase64(size = 256): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="100%" height="100%" fill="#3a2f2a"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 3}" fill="#e0b89a"/>
    <circle cx="${size * 0.4}" cy="${size * 0.45}" r="${size / 24}" fill="#222"/>
    <circle cx="${size * 0.6}" cy="${size * 0.45}" r="${size / 24}" fill="#222"/>
  </svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).withMetadata({ exif: { IFD0: { Copyright: 'test-exif' } } }).toBuffer();
  return jpeg.toString('base64');
}

export function consentsPayload(birthYear = 2000) {
  const at = new Date().toISOString();
  return {
    birthYear,
    consents: {
      processing: { version: LEGAL_VERSIONS.processing, acceptedAt: at },
      dissemination: {
        version: LEGAL_VERSIONS.dissemination,
        acceptedAt: at,
        scope: ['name', 'avatar', 'track', 'location'] as const,
      },
      rules: { version: LEGAL_VERSIONS.rules, acceptedAt: at },
    },
  };
}

export const sampleProfile: ProfileInput = {
  name: 'Тест',
  taste: { genres: ['pop', 'rock', 'indie'], moods: ['night'], artists: ['Земфира'] },
};

/** Полный онбординг через API. Возвращает токен с ob=true. */
export async function onboardUser(
  app: FastifyInstance,
  opts: { name?: string; birthYear?: number; installSecret?: string } = {},
) {
  const installSecret = opts.installSecret ?? newInstallSecret();
  const auth = await authDevice(app, { installSecret });
  const headers = bearer(auth.accessToken);

  const consents = await app.inject({ method: 'PUT', url: '/v1/me/consents', headers, payload: consentsPayload(opts.birthYear) });
  if (consents.statusCode !== 200) throw new Error(`consents ${consents.statusCode}: ${consents.body}`);
  Me.parse(consents.json());

  const avatar = await app.inject({ method: 'PUT', url: '/v1/me/avatar', headers, payload: { imageBase64: await sampleAvatarBase64() } });
  if (avatar.statusCode !== 200) throw new Error(`avatar ${avatar.statusCode}: ${avatar.body}`);

  const profile = await app.inject({
    method: 'PUT',
    url: '/v1/me/profile',
    headers,
    payload: { ...sampleProfile, name: opts.name ?? sampleProfile.name },
  });
  if (profile.statusCode !== 200) throw new Error(`profile ${profile.statusCode}: ${profile.body}`);
  const session = SessionResponse.parse(profile.json());
  return { installSecret, token: session.accessToken, me: session.me };
}
