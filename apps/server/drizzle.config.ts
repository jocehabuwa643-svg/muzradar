import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // generate работает офлайн; migrate/studio — против DATABASE_URL (или dev-PGlite на 54329)
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres' },
  extensionsFilters: ['postgis'],
});
