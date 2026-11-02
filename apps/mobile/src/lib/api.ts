import {
  API_PREFIX,
  ArtistSuggestionsResponse,
  AvatarUploadResponse,
  ClustersResponse,
  DeviceAuthResponse,
  Me,
  NearbyResponse,
  SectionsResponse,
  SessionResponse,
  Track,
  TracksResponse,
  type BBox,
  type ConsentsInput,
  type DeviceAuthRequest,
  type GenreId,
  type PresenceHeartbeat,
  type PresenceUpdate,
  type ProfileInput,
} from '@muzradar/shared';
import { Platform } from 'react-native';
import type { z } from 'zod';
import { useSession } from '@/state/session';
import { appConfig } from './config';
import { getDeviceHint, getInstallSecret } from './identity';

/** Ответ сервера с ошибкой (тело `ApiError`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Нет сети, таймаут или сервер недоступен. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions<S extends z.ZodType | undefined> {
  body?: unknown;
  query?: Query;
  schema?: S;
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type Result<S> = S extends z.ZodType ? z.output<S> : unknown;

function buildUrl(path: string, query?: Query): string {
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  return `${appConfig.apiUrl}${API_PREFIX}${path}${qs ? `?${qs}` : ''}`;
}

async function request<S extends z.ZodType | undefined = undefined>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: RequestOptions<S> = {},
): Promise<Result<S>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort);

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new NetworkError(controller.signal.aborted ? 'Сервер не отвечает' : 'Нет соединения с сервером');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const body = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.message ?? `Ошибка ${res.status}`, body.details);
  }
  return (opts.schema ? opts.schema.parse(json) : json) as Result<S>;
}

// ─── Сессия ──────────────────────────────────────────────────────────────────

export interface AccessSession {
  accessToken: string;
  expiresAt: number;
}

let session: AccessSession | null = null;
let inflight: Promise<AccessSession> | null = null;

function remember(accessToken: string, expiresInSec: number): AccessSession {
  session = { accessToken, expiresAt: Date.now() + expiresInSec * 1000 };
  return session;
}

/**
 * Обменивает секрет устройства на короткий токен. Один запрос на всех (single-flight).
 * Параллельно восстанавливает пройденные шаги онбординга из профиля на сервере.
 */
export function authenticate(force = false): Promise<AccessSession> {
  if (!force && session && session.expiresAt - Date.now() > 60_000) return Promise.resolve(session);
  inflight ??= (async () => {
    const hint = getDeviceHint();
    const body: DeviceAuthRequest = {
      installSecret: await getInstallSecret(),
      platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android',
      appVersion: appConfig.appVersion,
      ...(hint ? { deviceHint: hint } : {}),
    };
    const res = await request('POST', '/auth/device', { body, schema: DeviceAuthResponse });
    useSession.getState().applyServerMe(res.me, { isNew: res.isNew });
    return remember(res.accessToken, res.expiresInSec);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function getAccessToken(): Promise<string> {
  return (await authenticate()).accessToken;
}

/** Сбросить токен (например, после завершения онбординга токен сменился). */
export function clearSession() {
  session = null;
}

async function authed<S extends z.ZodType | undefined = undefined>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: Omit<RequestOptions<S>, 'token'> = {},
): Promise<Result<S>> {
  const s = await authenticate();
  try {
    return await request(method, path, { ...opts, token: s.accessToken });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const fresh = await authenticate(true);
      return request(method, path, { ...opts, token: fresh.accessToken });
    }
    throw err;
  }
}

// ─── Эндпоинты ───────────────────────────────────────────────────────────────

export const api = {
  me: (signal?: AbortSignal) => authed('GET', '/me', { schema: Me, signal }),

  putConsents: async (input: ConsentsInput) => {
    const me = await authed('PUT', '/me/consents', { body: input, schema: Me });
    useSession.getState().applyServerMe(me);
    return me;
  },

  putAvatar: (imageBase64: string) =>
    authed('PUT', '/me/avatar', { body: { imageBase64 }, schema: AvatarUploadResponse, timeoutMs: 30_000 }),

  /** Завершает онбординг: сервер выдаёт новый токен с доступом к карте и музыке. */
  putProfile: async (input: ProfileInput) => {
    const res = await authed('PUT', '/me/profile', { body: input, schema: SessionResponse });
    remember(res.accessToken, res.expiresInSec);
    useSession.getState().applyServerMe(res.me);
    return res;
  },

  artists: (genres: readonly GenreId[], signal?: AbortSignal) =>
    authed('GET', '/catalog/artists', { query: { genres: genres.join(',') }, schema: ArtistSuggestionsResponse, signal }),

  sections: (signal?: AbortSignal) => authed('GET', '/catalog/sections', { schema: SectionsResponse, signal, timeoutMs: 25_000 }),

  search: (q: string, limit = 25, signal?: AbortSignal) =>
    authed('GET', '/catalog/search', { query: { q, limit }, schema: TracksResponse, signal }),

  track: (id: string, signal?: AbortSignal) =>
    authed('GET', `/catalog/tracks/${encodeURIComponent(id)}`, { schema: Track, signal }),

  nearby: (bbox: BBox, zoom: number, signal?: AbortSignal) =>
    authed('GET', '/presence/nearby', { query: { bbox: bbox.join(','), zoom }, schema: NearbyResponse, signal }),

  clusters: (bbox: BBox, zoom: number, signal?: AbortSignal) =>
    authed('GET', '/presence/clusters', { query: { bbox: bbox.join(','), zoom }, schema: ClustersResponse, signal }),

  heartbeat: (hb: PresenceHeartbeat) => authed('POST', '/presence/heartbeat', { body: hb }),

  /** Обновление позиции по HTTP — для Live-режима из фоновой задачи, где сокета нет. */
  presenceUpdate: (update: PresenceUpdate) => authed('POST', '/presence', { body: update }),
};
