import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { Config } from '../config.ts';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  db: Db;
  pool: pg.Pool;
  url: string;
  embedded: boolean;
  close(): Promise<void>;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface EmbeddedPostgres {
  url: string;
  stop(): Promise<void>;
}

/**
 * Postgres в процессе (PGlite) за wire-протоколом — только для dev и тестов.
 * Код приложения ходит в него через обычный `pg`, как в продакшене.
 * dataDir `memory://` — без диска.
 */
export async function startEmbeddedPostgres(dataDir: string, port: number): Promise<EmbeddedPostgres> {
  const [{ PGlite }, { PGLiteSocketServer }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite-socket'),
  ]);
  if (!dataDir.startsWith('memory://')) await mkdir(dataDir, { recursive: true });
  const pglite = await PGlite.create(dataDir);
  // maxConnections по умолчанию 1: второе соединение пула получает ECONNRESET.
  const server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port, maxConnections: 8 });
  await server.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await pglite.close();
    },
  };
}

export async function openDatabase(
  config: Pick<Config, 'env' | 'databaseUrl' | 'pgliteDir' | 'pglitePort'>,
  options: { migrate?: boolean } = {},
): Promise<Database> {
  let url = config.databaseUrl;
  let embedded: EmbeddedPostgres | undefined;
  if (!url) {
    if (config.env === 'production') throw new Error('DATABASE_URL is required in production');
    embedded = await startEmbeddedPostgres(config.pgliteDir, config.pglitePort);
    url = embedded.url;
  }

  // У PGlite одна сессия на всех: параллельные соединения рвут друг другу portal/prepared statement
  // (замерено: 34000 portal "" does not exist). Поэтому в dev одно соединение, внутри транзакции — только tx.
  const pool = new pg.Pool({ connectionString: url, max: embedded ? 1 : 20, idleTimeoutMillis: 30_000 });
  const db = drizzle({ client: pool, schema });

  try {
    if (options.migrate !== false) await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } catch (err) {
    await pool.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
    throw err;
  }

  return {
    db,
    pool,
    url,
    embedded: Boolean(embedded),
    async close() {
      await pool.end();
      await embedded?.stop();
    },
  };
}
