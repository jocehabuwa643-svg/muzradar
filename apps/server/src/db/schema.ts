// Схема не импортирует @muzradar/shared: drizzle-kit грузит её обычным резолвером Node.
import { sql } from 'drizzle-orm';
import { customType, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export interface TasteJson {
  genres: string[];
  moods: string[];
  artists: string[];
}

/** Аватары адресуются хешем содержимого: одинаковые байты хранятся один раз. */
export const avatars = pgTable('avatars', {
  hash: text('hash').primaryKey(),
  /** 128×128 WebP без метаданных. */
  webp: bytea('webp').notNull(),
  /** 96×96 круглый WebP с альфой для карты. */
  mapWebp: bytea('map_webp').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    birthYear: integer('birth_year'),
    visibility: text('visibility', { enum: ['public', 'followers', 'ghost'] }).notNull().default('public'),
    taste: jsonb('taste').$type<TasteJson>(),
    avatarHash: text('avatar_hash').references(() => avatars.hash, { onDelete: 'set null' }),
    consentsVersion: text('consents_version'),
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('users_active_idx').on(t.id).where(sql`${t.deletedAt} is null`)],
);

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256(installSecret) — сам секрет сервер не хранит. */
    secretHash: text('secret_hash').notNull(),
    /** HMAC(pepper, Android ID) — только для восстановления после переустановки. */
    hintHmac: text('hint_hmac'),
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    appVersion: text('app_version').notNull(),
    /** Последний IP — только антифрод, никогда не опознание. */
    lastIp: text('last_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('devices_secret_hash_uq').on(t.secretHash),
    index('devices_hint_hmac_idx').on(t.hintHmac).where(sql`${t.hintHmac} is not null and ${t.revokedAt} is null`),
    index('devices_user_idx').on(t.userId),
  ],
);

/** Журнал согласий (152-ФЗ): каждая версия каждого согласия — отдельная строка. */
export const consents = pgTable(
  'consents',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id'),
    kind: text('kind', { enum: ['processing', 'dissemination', 'rules'] }).notNull(),
    version: text('version').notNull(),
    scope: jsonb('scope').$type<string[]>(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
  },
  (t) => [index('consents_user_idx').on(t.userId, t.kind)],
);

export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type AvatarRow = typeof avatars.$inferSelect;
