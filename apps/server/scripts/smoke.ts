/**
 * Сквозная проверка живого сервера: регистрация → согласия → аватар → профиль → карта (сокеты).
 * Запуск: npm run smoke -w @muzradar/server  (сервер должен быть поднят: npm run dev:server)
 * Флаги: --base=http://127.0.0.1:8080  --catalog (дополнительно дёрнуть живые источники музыки)
 */
import { randomBytes } from 'node:crypto';
import {
  AvatarUploadResponse,
  DeviceAuthResponse,
  LEGAL_VERSIONS,
  Me,
  REALTIME_PATH,
  SectionsResponse,
  SessionResponse,
  encodeGeohash,
  type ClientToServerEvents,
  type PresenceView,
  type ServerToClientEvents,
  type ViewportAck,
  type AckResult,
} from '@muzradar/shared';
import sharp from 'sharp';
import { io, type Socket } from 'socket.io-client';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'] as const;
  }),
);
const BASE = (args.get('base') ?? process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const withCatalog = args.has('catalog');

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let step = 0;
function ok(msg: string) {
  console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { res, json: text ? (JSON.parse(text) as unknown) : null };
}

async function onboard(name: string) {
  const auth = DeviceAuthResponse.parse(
    (
      await call('POST', '/v1/auth/device', {
        installSecret: randomBytes(32).toString('base64url'),
        platform: 'android',
        appVersion: 'smoke',
      })
    ).json,
  );
  const at = new Date().toISOString();
  Me.parse(
    (
      await call(
        'PUT',
        '/v1/me/consents',
        {
          birthYear: 1995,
          consents: {
            processing: { version: LEGAL_VERSIONS.processing, acceptedAt: at },
            dissemination: { version: LEGAL_VERSIONS.dissemination, acceptedAt: at, scope: ['name', 'avatar', 'track', 'location'] },
            rules: { version: LEGAL_VERSIONS.rules, acceptedAt: at },
          },
        },
        auth.accessToken,
      )
    ).json,
  );
  const jpeg = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#c49a7a' } }).jpeg({ quality: 70 }).toBuffer();
  const avatar = AvatarUploadResponse.parse(
    (await call('PUT', '/v1/me/avatar', { imageBase64: jpeg.toString('base64') }, auth.accessToken)).json,
  );
  const session = SessionResponse.parse(
    (
      await call(
        'PUT',
        '/v1/me/profile',
        { name, taste: { genres: ['indie', 'electronic', 'hiphop'], moods: ['night'], artists: ['Кино'] } },
        auth.accessToken,
      )
    ).json,
  );
  return { token: session.accessToken, me: session.me, avatar };
}

function connect(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const s: Client = io(BASE, { path: REALTIME_PATH, transports: ['websocket'], auth: { token }, reconnection: false });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
}

function ack<T>(p: Promise<AckResult<T>>): Promise<T> {
  return p.then((r) => {
    if (!r.ok) throw new Error(r.error);
    return r.data;
  });
}

async function main() {
  console.log(`МУЗРАДАР smoke → ${BASE}`);
  const health = (await call('GET', '/health')).json as { ok: boolean; db: boolean; presence: string };
  if (!health.ok || !health.db) throw new Error(`health: ${JSON.stringify(health)}`);
  ok(`health (db ok, presence ${health.presence})`);

  const a = await onboard('Смоук А');
  ok(`user A onboarded (${a.me.id}), avatar ${a.avatar.bytes} B`);
  const b = await onboard('Смоук Б');
  ok(`user B onboarded (${b.me.id})`);

  const img = await fetch(`${BASE}${a.avatar.mapAvatarUrl}`);
  if (img.status !== 200 || img.headers.get('content-type') !== 'image/webp') throw new Error(`map avatar ${img.status}`);
  ok(`map avatar served (${img.headers.get('cache-control')})`);

  const sa = await connect(a.token);
  const sb = await connect(b.token);
  ok('both sockets connected');

  const viewport = { bbox: [37.55, 55.72, 37.7, 55.78] as const, zoom: 14 };
  const vp = await ack<ViewportAck>(sa.timeout(5000).emitWithAck('viewport:set', { bbox: [...viewport.bbox] as [number, number, number, number], zoom: viewport.zoom }) as Promise<AckResult<ViewportAck>>);
  if (vp.mode !== 'live') throw new Error(`viewport mode ${vp.mode}`);
  ok(`A watches ${vp.rooms} rooms, snapshot ${vp.users.length}`);

  const seen = new Promise<PresenceView>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('A did not receive B within 5 s')), 5000);
    sa.on('presence:delta', ({ upserts }) => {
      const hit = upserts.find((u) => u.userId === b.me.id);
      if (hit) {
        clearTimeout(timer);
        resolve(hit);
      }
    });
  });
  const cell = encodeGeohash(55.7558, 37.6176, 7);
  await ack(
    sb.timeout(5000).emitWithAck('presence:update', {
      cell,
      motion: 'walk',
      approx: false,
      track: { id: 'audius:smoke', title: 'Smoke Test', artist: 'МУЗРАДАР', artworkUrl: null, playback: 'full' },
      playing: true,
      positionSec: 12,
    }) as Promise<AckResult<null>>,
  );
  const view = await seen;
  if (view.precision !== 6) throw new Error(`precision ${view.precision}`);
  ok(`A sees B blurred to p6 at ${view.lat.toFixed(4)},${view.lng.toFixed(4)} with «${view.track?.title}»`);

  sa.disconnect();
  sb.disconnect();

  if (withCatalog) {
    const t0 = Date.now();
    const sections = SectionsResponse.parse((await call('GET', '/v1/catalog/sections', undefined, a.token)).json);
    const total = sections.sections.reduce((n, s) => n + s.tracks.length, 0);
    ok(`catalog: ${sections.sections.length} sections, ${total} tracks in ${Date.now() - t0} ms (${sections.sections.map((s) => s.id).join(', ')})`);
    const first = sections.sections[0]?.tracks[0];
    if (first) {
      const track = (await call('GET', `/v1/catalog/tracks/${encodeURIComponent(first.id)}`, undefined, a.token)).json as { streamUrl: string | null };
      if (!track.streamUrl) throw new Error('resolved track has no streamUrl');
      const head = await fetch(track.streamUrl, { headers: { range: 'bytes=0-1023' }, redirect: 'follow' });
      ok(`stream ${first.id}: HTTP ${head.status} ${head.headers.get('content-type')}`);
    }
  }

  console.log('smoke passed');
}

main().catch((err: unknown) => {
  console.error('smoke FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
