import type { DeviceAuthRequest } from '@muzradar/shared';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { devices, users, type UserRow } from '../../db/schema.ts';
import { hmacHex, newDeviceId, newUserId, sha256Hex } from '../../ids.ts';
import { httpError } from '../../plugins/errors.ts';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DeviceSession {
  user: UserRow;
  deviceId: string;
  isNew: boolean;
  restored: boolean;
}

export interface DeviceAuthContext {
  db: Db;
  config: Pick<Config, 'androidIdPepper'>;
  now: Date;
  /** Пишется только в devices.last_ip (антифрод). В опознании не участвует. */
  ip: string;
}

/** Хватает с запасом: проигравший гонку со вторым попаданием находит устройство. */
const MAX_ATTEMPTS = 3;

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Одновременные запросы с одним секретом на этой ноде выполняются по очереди: второй сразу
 * попадает во вход (a), а не в заведомо проигрышную транзакцию. Между нодами гонку решает
 * уникальный индекс. Заодно встроенный PGlite не получает параллельных запросов из разных
 * соединений пула — он путает их безымянные portal'ы («portal "" does not exist»).
 */
async function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (inFlight.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

/**
 * Секрет устройства → аккаунт.
 * a) живое устройство с этим секретом → вход;
 * b) Android с deviceHint → восстановление после переустановки (старые устройства отзываются);
 * c) иначе новый аккаунт.
 */
export async function authenticateDevice(input: DeviceAuthRequest, ctx: DeviceAuthContext): Promise<DeviceSession> {
  const secretHash = sha256Hex(input.installSecret);
  return singleFlight(secretHash, () => resolveDevice(input, ctx, secretHash));
}

async function resolveDevice(input: DeviceAuthRequest, ctx: DeviceAuthContext, secretHash: string): Promise<DeviceSession> {
  const hintHmac =
    input.platform === 'android' && input.deviceHint
      ? hmacHex(ctx.config.androidIdPepper, input.deviceHint.toLowerCase())
      : null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const known = await touchKnownDevice(ctx, secretHash, hintHmac, input.appVersion);
    if (known) return known;
    try {
      const restored = hintHmac ? await restoreByHint(ctx, secretHash, hintHmac, input.appVersion) : null;
      return restored ?? (await createAccount(ctx, secretHash, hintHmac, input));
    } catch (err) {
      // Первый запуск часто шлёт два запроса подряд (ретрай, двойной старт): второй упирается
      // в devices_secret_hash_uq, его транзакция откатывается целиком, и он становится входом (a).
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw httpError.unavailable('auth_busy', 'Не удалось войти, повторите попытку');
}

async function touchKnownDevice(
  ctx: DeviceAuthContext,
  secretHash: string,
  hintHmac: string | null,
  appVersion: string,
): Promise<DeviceSession | null> {
  const [row] = await ctx.db
    .select({ deviceId: devices.id, deviceHint: devices.hintHmac, user: users })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(and(eq(devices.secretHash, secretHash), isNull(devices.revokedAt), isNull(users.deletedAt)))
    .limit(1);
  if (!row) return null;

  await ctx.db
    .update(devices)
    .set({
      lastSeenAt: ctx.now,
      lastIp: ctx.ip,
      appVersion,
      // Android ID мог быть недоступен при первом входе — дописываем, чтобы переустановка восстанавливалась.
      ...(hintHmac && !row.deviceHint ? { hintHmac } : {}),
    })
    .where(eq(devices.id, row.deviceId));
  return { user: row.user, deviceId: row.deviceId, isNew: false, restored: false };
}

async function restoreByHint(
  ctx: DeviceAuthContext,
  secretHash: string,
  hintHmac: string,
  appVersion: string,
): Promise<DeviceSession | null> {
  const [prev] = await ctx.db
    .select({ user: users })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(
      and(
        eq(devices.hintHmac, hintHmac),
        eq(devices.platform, 'android'),
        isNull(devices.revokedAt),
        isNull(users.deletedAt),
      ),
    )
    .orderBy(desc(devices.createdAt))
    .limit(1);
  if (!prev) return null;

  const deviceId = newDeviceId();
  await ctx.db.transaction(async (tx) => {
    // Старая установка стёрта вместе с секретом; если секрет утёк, он больше ничего не открывает.
    await tx
      .update(devices)
      .set({ revokedAt: ctx.now })
      .where(and(eq(devices.userId, prev.user.id), eq(devices.hintHmac, hintHmac), isNull(devices.revokedAt)));
    await releaseDeadSecret(tx, secretHash, ctx.now);
    await tx.insert(devices).values({
      id: deviceId,
      userId: prev.user.id,
      secretHash,
      hintHmac,
      platform: 'android',
      appVersion,
      lastIp: ctx.ip,
      createdAt: ctx.now,
      lastSeenAt: ctx.now,
    });
  });
  return { user: prev.user, deviceId, isNew: false, restored: true };
}

async function createAccount(
  ctx: DeviceAuthContext,
  secretHash: string,
  hintHmac: string | null,
  input: DeviceAuthRequest,
): Promise<DeviceSession> {
  const userId = newUserId();
  const deviceId = newDeviceId();
  const user = await ctx.db.transaction(async (tx) => {
    await releaseDeadSecret(tx, secretHash, ctx.now);
    const [created] = await tx.insert(users).values({ id: userId, createdAt: ctx.now, updatedAt: ctx.now }).returning();
    await tx.insert(devices).values({
      id: deviceId,
      userId,
      secretHash,
      hintHmac,
      platform: input.platform,
      appVersion: input.appVersion,
      lastIp: ctx.ip,
      createdAt: ctx.now,
      lastSeenAt: ctx.now,
    });
    return created!;
  });
  return { user, deviceId, isNew: true, restored: false };
}

/**
 * Уникальный индекс по secret_hash покрывает и мёртвые записи (отозванное устройство,
 * удалённый аккаунт). Такой секрет ведёт себя как незнакомый: запись освобождает его,
 * иначе вставка нового устройства упиралась бы в индекс бесконечно.
 * Живые устройства не трогаются — это важно при гонке двух первых запросов.
 */
async function releaseDeadSecret(tx: Tx, secretHash: string, now: Date): Promise<void> {
  const deletedUsers = tx.select({ id: users.id }).from(users).where(isNotNull(users.deletedAt));
  await tx
    .update(devices)
    .set({
      secretHash: sql`'released:' || ${devices.id}`,
      revokedAt: sql`coalesce(${devices.revokedAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(devices.secretHash, secretHash),
        or(isNotNull(devices.revokedAt), inArray(devices.userId, deletedUsers)),
      ),
    );
}

/** 23505 из pg; drizzle 0.45 заворачивает ошибку драйвера в DrizzleQueryError.cause. */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
