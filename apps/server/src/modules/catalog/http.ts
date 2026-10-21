import { z } from 'zod';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Ограничение на хост: не чаще `rps` запусков в секунду и не больше `concurrency` одновременно. */
export interface HostPolicy {
  rps?: number;
  concurrency?: number;
}

/** Лимиты из условий источников (digest music-sources): Audius ≤ 10 rps, IA ≤ 2 одновременно. */
export const HOST_POLICIES: Readonly<Record<string, HostPolicy>> = {
  'api.audius.co': { rps: 10 },
  'archive.org': { concurrency: 2 },
  'commons.wikimedia.org': { rps: 5 },
  // 35 000 запросов в месяц на некоммерческом плане: держим темп скромным, объём режет кэш.
  'api.jamendo.com': { rps: 2, concurrency: 2 },
  // MetaBrainz просит не чаще 1 запроса в секунду с IP (иначе 503 на всех).
  'musicbrainz.org': { rps: 1, concurrency: 1 },
  'labs.api.listenbrainz.org': { rps: 1, concurrency: 1 },
};

export class UpstreamError extends Error {
  readonly status: number | null;
  readonly host: string;

  constructor(host: string, status: number | null, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.host = host;
    this.status = status;
  }
}

export interface HttpClientOptions {
  userAgent: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Повторы на 429/503. */
  retries?: number;
  backoffMs?: number;
  policies?: Readonly<Record<string, HostPolicy>>;
  now?: () => number;
}

class HostGate {
  private readonly interval: number;
  private readonly limit: number;
  private active = 0;
  private nextStart = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(policy: HostPolicy, now: () => number) {
    this.interval = policy.rps ? 1000 / policy.rps : 0;
    this.limit = policy.concurrency ?? Number.POSITIVE_INFINITY;
    this.now = now;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal.reason);
        };
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(wake);
      });
    }
    this.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
    if (this.interval > 0) {
      // Слот запуска резервируется сразу: параллельные вызовы выстраиваются по интервалу.
      const now = this.now();
      const slot = Math.max(now, this.nextStart);
      this.nextStart = slot + this.interval;
      try {
        await sleep(slot - now, signal);
      } catch (err) {
        release();
        throw err;
      }
    }
    return release;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(res: Response): number | null {
  const value = res.headers.get('retry-after');
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec)) return sec * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * Клиент к внешним каталогам: лимиты на хост, таймаут, повтор на 429/503
 * и терпимая проверка ответа — схемы описывают только используемые поля.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly policies: Readonly<Record<string, HostPolicy>>;
  private readonly gates = new Map<string, HostGate>();
  private readonly now: () => number;

  constructor(opts: HttpClientOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = opts.userAgent;
    this.timeoutMs = opts.timeoutMs ?? 6_000;
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 300;
    this.policies = opts.policies ?? HOST_POLICIES;
    this.now = opts.now ?? Date.now;
  }

  private gate(host: string): HostGate | null {
    const policy = this.policies[host];
    if (!policy) return null;
    let gate = this.gates.get(host);
    if (!gate) {
      gate = new HostGate(policy, this.now);
      this.gates.set(host, gate);
    }
    return gate;
  }

  async getJson<S extends z.ZodType>(url: string, schema: S, signal: AbortSignal): Promise<z.output<S>> {
    const host = new URL(url).host;
    const gate = this.gate(host);
    for (let attempt = 0; ; attempt++) {
      const release = gate ? await gate.acquire(signal) : () => undefined;
      let res: Response;
      let body: unknown;
      try {
        const reqSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': this.userAgent },
          signal: reqSignal,
          redirect: 'follow',
        });
        if (res.ok) body = await res.json();
        else await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        const message = err instanceof Error ? err.message : String(err);
        throw new UpstreamError(host, null, `${host}: ${message}`);
      } finally {
        release();
      }

      if (res.ok) {
        const parsed = schema.safeParse(body);
        if (!parsed.success) throw new UpstreamError(host, res.status, `${host}: unexpected response shape`);
        return parsed.data;
      }
      if ((res.status === 429 || res.status === 503) && attempt < this.retries) {
        const hinted = retryAfterMs(res);
        const backoff = this.backoffMs * 2 ** attempt + Math.floor(Math.random() * this.backoffMs);
        // Retry-After уважаем, но не ждём дольше дедлайна раздела.
        await sleep(Math.min(hinted ?? backoff, 3_000), signal);
        continue;
      }
      throw new UpstreamError(host, res.status, `${host}: HTTP ${res.status}`);
    }
  }
}

/** Массив, из которого молча выбрасываются элементы неожиданной формы. */
export function lenientArray<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((raw) => {
        const r = item.safeParse(raw);
        return r.success ? [r.data as z.output<T>] : [];
      }),
    );
}

/** Строка или null; числа приводятся к строке (id у Jamendo бывают числом). */
export const looseString = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined ? null : String(v)));

/** Параллельная обработка с потолком одновременных задач. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i] as T) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
