import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'muzradar-pwa-'));
  await mkdir(join(dir, '_expo', 'static', 'js', 'web'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>МУЗРАДАР</title>');
  await writeFile(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  await writeFile(join(dir, '_expo', 'static', 'js', 'web', 'entry-abc.js'), 'console.log("ok");');
  ctx = await createTestContext({ env: { PWA_STATIC_DIR: dir } });
});

afterAll(async () => {
  await ctx?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('PWA static hosting', () => {
  it('serves index at / and falls back to it for client routes', async () => {
    for (const url of ['/', '/onboarding']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('МУЗРАДАР');
    }
  });

  it('does not intercept health or API errors with the SPA', async () => {
    const health = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });
    const api = await ctx.app.inject({ method: 'POST', url: '/v1/auth/device', payload: {} });
    expect(api.statusCode).toBe(400);
    expect(api.json()).toMatchObject({ error: 'validation' });
  });

  it('keeps service worker updateable and hashed assets cacheable', async () => {
    const sw = await ctx.app.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['cache-control']).toBe('no-cache');
    const asset = await ctx.app.inject({ method: 'GET', url: '/_expo/static/js/web/entry-abc.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('resolves a relative PWA_STATIC_DIR before starting Fastify', () => {
    const { testConfig } = require('./helpers.ts') as typeof import('./helpers.ts');
    const { resolve } = require('node:path') as typeof import('node:path');
    expect(testConfig({ PWA_STATIC_DIR: '../mobile/dist' }).pwaStaticDir).toBe(resolve('../mobile/dist'));
  });
});
