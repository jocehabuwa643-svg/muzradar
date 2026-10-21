import { readFileSync } from 'node:fs';
import { HttpClient, type FetchLike, type HttpClientOptions } from '../../../src/modules/catalog/http.ts';

/** Записанный ответ источника. Тесты сети не трогают. */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')) as T;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface StubRoute {
  /** Подстрока или регулярное выражение (без флага g) по URL запроса. */
  match: string | RegExp;
  body?: unknown;
  status?: number;
  handler?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export interface Stub {
  fetch: FetchLike;
  calls: string[];
}

export function stubFetch(routes: readonly StubRoute[]): Stub {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)));
    if (!route) return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404 });
    if (route.handler) return route.handler(url, init);
    return jsonResponse(route.body ?? {}, route.status ?? 200);
  };
  return { fetch: fetchImpl, calls };
}

/** Источник, который «завис»: отвечает только отменой запроса — как настоящий fetch по сигналу. */
export function hang(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Клиент без пауз между запросами: лимиты источников в тестах только мешают. */
export function testHttp(routes: readonly StubRoute[], opts: Partial<HttpClientOptions> = {}) {
  const stub = stubFetch(routes);
  const http = new HttpClient({
    userAgent: 'MuzRadarTest/0.1 ( test@muzradar.local )',
    fetch: stub.fetch,
    policies: {},
    timeoutMs: 2_000,
    retries: 0,
    backoffMs: 1,
    ...opts,
  });
  return { http, calls: stub.calls };
}

/** Сигнал, который сам не сработает: дедлайн в тестах задаёт сам тест. */
export function openSignal(): AbortSignal {
  return new AbortController().signal;
}
