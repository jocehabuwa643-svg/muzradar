import { describe, expect, it } from 'vitest';
import { CACHE_TTL, TtlCache } from '../src/modules/catalog/cache.ts';
import { HttpClient, lenientArray, mapLimit, UpstreamError } from '../src/modules/catalog/http.ts';
import { z } from 'zod';
import { openSignal, stubFetch } from './fixtures/catalog/harness.ts';

const Payload = z.object({ data: lenientArray(z.object({ id: z.string() })) });

function client(routes: Parameters<typeof stubFetch>[0], over: Record<string, unknown> = {}) {
  const stub = stubFetch(routes);
  return {
    calls: stub.calls,
    http: new HttpClient({
      userAgent: 'MuzRadarTest/0.1 ( test@muzradar.local )',
      fetch: stub.fetch,
      policies: {},
      timeoutMs: 500,
      retries: 2,
      backoffMs: 1,
      ...over,
    }),
  };
}

describe('HttpClient', () => {
  it('схема терпима: элементы неожиданной формы выбрасываются, а не ломают ответ', async () => {
    const { http } = client([{ match: 'example.com', body: { data: [{ id: 'a' }, { nope: 1 }, null, { id: 'b' }], extra: 'ok' } }]);
    const res = await http.getJson('https://example.com/x', Payload, openSignal());
    expect(res.data).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('пропавший список деградирует в пустой, а пропавшее обязательное поле — ошибка', async () => {
    const { http } = client([{ match: 'example.com', body: { oops: true } }]);
    // список с `catch([])`: раздел останется пустым, но ответ не сломается
    expect((await http.getJson('https://example.com/x', Payload, openSignal())).data).toEqual([]);
    // а вот отсутствие обязательного блока (как `headers` у Jamendo) — уже ошибка источника
    const Strict = z.object({ headers: z.object({ status: z.string() }) });
    await expect(http.getJson('https://example.com/x', Strict, openSignal())).rejects.toBeInstanceOf(UpstreamError);
  });

  it('User-Agent обязателен для MusicBrainz, IA и Commons — он уходит всегда', async () => {
    let seen: string | null = null;
    const stub = stubFetch([
      {
        match: 'example.com',
        handler: () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      },
    ]);
    const http = new HttpClient({
      userAgent: 'MuzRadar/0.1 ( dev@muzradar.local )',
      policies: {},
      fetch: (input, init) => {
        seen = new Headers(init?.headers).get('user-agent');
        return stub.fetch(input, init);
      },
    });
    await http.getJson('https://example.com/x', Payload, openSignal());
    expect(seen).toBe('MuzRadar/0.1 ( dev@muzradar.local )');
  });

  it('503 и 429 повторяются, но не больше двух раз', async () => {
    let attempts = 0;
    const { http } = client([
      {
        match: 'example.com',
        handler: () => {
          attempts++;
          if (attempts < 3) return new Response('busy', { status: 503 });
          return new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    ]);
    const res = await http.getJson('https://example.com/x', Payload, openSignal());
    expect(res.data).toEqual([{ id: 'a' }]);
    expect(attempts).toBe(3);

    let always = 0;
    const { http: failing } = client([
      {
        match: 'example.com',
        handler: () => {
          always++;
          return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
        },
      },
    ]);
    await expect(failing.getJson('https://example.com/x', Payload, openSignal())).rejects.toThrow(/HTTP 429/);
    expect(always).toBe(3);
  });

  it('404 не повторяется', async () => {
    let attempts = 0;
    const { http } = client([
      {
        match: 'example.com',
        handler: () => {
          attempts++;
          return new Response('nope', { status: 404 });
        },
      },
    ]);
    await expect(http.getJson('https://example.com/x', Payload, openSignal())).rejects.toMatchObject({ status: 404 });
    expect(attempts).toBe(1);
  });

  it('таймаут отменяет запрос, а не подвешивает раздел', async () => {
    const http = new HttpClient({
      userAgent: 'test',
      policies: {},
      timeoutMs: 40,
      retries: 0,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    await expect(http.getJson('https://example.com/x', Payload, openSignal())).rejects.toBeInstanceOf(UpstreamError);
  });

  it('лимит на хост растягивает запросы во времени', async () => {
    const { http } = client([{ match: 'api.audius.co', body: { data: [] } }], {
      policies: { 'api.audius.co': { rps: 20 } },
    });
    const started = Date.now();
    await Promise.all([1, 2, 3].map(() => http.getJson('https://api.audius.co/v1/tracks', Payload, openSignal())));
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it('лимит одновременных запросов соблюдается (archive.org — не больше двух)', async () => {
    let active = 0;
    let peak = 0;
    const { http } = client(
      [
        {
          match: 'archive.org',
          handler: async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 20));
            active--;
            return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
          },
        },
      ],
      { policies: { 'archive.org': { concurrency: 2 } } },
    );
    await Promise.all([1, 2, 3, 4, 5].map(() => http.getJson('https://archive.org/metadata/x', Payload, openSignal())));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('mapLimit держит потолок параллельности и возвращает все исходы', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (n === 3) throw new Error('нет');
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  });
});

describe('TtlCache', () => {
  it('значение живёт ровно до истечения TTL', () => {
    const clock = { now: 1_000 };
    const cache = new TtlCache<string>({ max: 10, now: () => clock.now });
    cache.set('a', 'x', 100);
    expect(cache.get('a')).toBe('x');
    clock.now += 99;
    expect(cache.get('a')).toBe('x');
    clock.now += 2;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('при переполнении вылетает давно не используемое', () => {
    const cache = new TtlCache<string>({ max: 2 });
    cache.set('a', '1', 10_000);
    cache.set('b', '2', 10_000);
    cache.get('a');
    cache.set('c', '3', 10_000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
  });

  it('одновременные промахи сливаются в один запрос, ошибки не кэшируются', async () => {
    const cache = new TtlCache<number>({ max: 10 });
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    };
    const [a, b] = await Promise.all([cache.wrap('k', 1_000, load), cache.wrap('k', 1_000, load)]);
    expect([a, b]).toEqual([42, 42]);
    expect(loads).toBe(1);

    await expect(cache.wrap('err', 1_000, () => Promise.reject(new Error('нет')))).rejects.toThrow('нет');
    expect(cache.get('err')).toBeUndefined();
  });

  it('TTL можно вычислить по значению — промах помнится меньше попадания', async () => {
    const clock = { now: 0 };
    const cache = new TtlCache<string | null>({ max: 10, now: () => clock.now });
    await cache.wrap('miss', (v) => (v ? 10_000 : 100), () => Promise.resolve(null));
    clock.now += 200;
    expect(cache.get('miss')).toBeUndefined();
  });

  it('сроки кэша не выходят за суточный потолок из условий Audius', () => {
    expect(CACHE_TTL.sectionsMs).toBeLessThanOrEqual(CACHE_TTL.audiusMetaMaxMs);
    expect(CACHE_TTL.searchMs).toBeLessThanOrEqual(CACHE_TTL.audiusMetaMaxMs);
    expect(CACHE_TTL.resolveMs).toBeLessThanOrEqual(CACHE_TTL.audiusMetaMaxMs);
  });
});
