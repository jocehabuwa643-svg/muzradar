import { z } from 'zod';

const DEV_SECRET = 'dev-only-secret-do-not-use-in-production-0000';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    /** Не задан → в процессе поднимается PGlite (только dev/test). */
    DATABASE_URL: optionalString,
    PGLITE_DIR: z.string().default('.data/pglite'),
    PGLITE_PORT: z.coerce.number().int().default(54329),
    /** Не задан → присутствие и лимиты в памяти процесса (одна нода). */
    REDIS_URL: optionalString,

    JWT_SECRET: optionalString,
    PRESENCE_JITTER_SECRET: optionalString,
    ANDROID_ID_PEPPER: optionalString,
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),

    /** CIDR-список доверенных прокси. Число (hop count) в Fastify 5.12 «закрывается» — не использовать. */
    TRUST_PROXY: optionalString,
    CORS_ORIGINS: optionalString,
    /** База для ссылок на аватары (CDN). Не задана → относительные пути `/v1/...`. */
    ASSETS_BASE_URL: optionalString,

    AUDIUS_API_KEY: optionalString,
    AUDIUS_APP_NAME: z.string().default('MUZRADAR'),
    JAMENDO_CLIENT_ID: optionalString,
    LISTENBRAINZ_TOKEN: optionalString,
    /** Похожие артисты в «Для вас» (MusicBrainz → ListenBrainz labs, токен не нужен). По умолчанию выключено. */
    LISTENBRAINZ_SIMILAR_ARTISTS: z
      .string()
      .optional()
      .transform((v) => /^(?:1|true|yes|on)$/i.test(v?.trim() ?? '')),
    MB_USER_AGENT: z.string().default('MuzRadar/0.1 ( dev@muzradar.local )'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['DATABASE_URL', 'JWT_SECRET', 'PRESENCE_JITTER_SECRET', 'ANDROID_ID_PEPPER'] as const) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` });
    }
    for (const key of ['JWT_SECRET', 'PRESENCE_JITTER_SECRET', 'ANDROID_ID_PEPPER'] as const) {
      const v = env[key];
      if (v && v.length < 32) ctx.addIssue({ code: 'custom', path: [key], message: `${key} must be ≥ 32 chars` });
    }
    if (env.TRUST_PROXY && /^\d+$/.test(env.TRUST_PROXY)) {
      ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY'], message: 'use a CIDR list, not a hop count' });
    }
  });

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string | undefined;
  pgliteDir: string;
  pglitePort: number;
  redisUrl: string | undefined;
  jwtSecret: string;
  presenceJitterSecret: string;
  androidIdPepper: string;
  accessTokenTtlSec: number;
  trustProxy: string | undefined;
  corsOrigins: string[] | true;
  assetsBaseUrl: string;
  audius: { apiKey: string | undefined; appName: string };
  jamendoClientId: string | undefined;
  listenBrainzToken: string | undefined;
  listenBrainzSimilarArtists: boolean;
  mbUserAgent: string;
  /** true, если какие-то секреты взяты из dev-заглушек. */
  usingDevSecrets: boolean;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${lines}`);
  }
  const env = parsed.data;
  const usingDevSecrets = !env.JWT_SECRET || !env.PRESENCE_JITTER_SECRET || !env.ANDROID_ID_PEPPER;
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    pgliteDir: env.PGLITE_DIR,
    pglitePort: env.PGLITE_PORT,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET ?? `${DEV_SECRET}-jwt`,
    presenceJitterSecret: env.PRESENCE_JITTER_SECRET ?? `${DEV_SECRET}-jitter`,
    androidIdPepper: env.ANDROID_ID_PEPPER ?? `${DEV_SECRET}-pepper`,
    accessTokenTtlSec: env.ACCESS_TOKEN_TTL_SEC,
    trustProxy: env.TRUST_PROXY,
    corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()) : true,
    assetsBaseUrl: (env.ASSETS_BASE_URL ?? '').replace(/\/+$/, ''),
    audius: { apiKey: env.AUDIUS_API_KEY, appName: env.AUDIUS_APP_NAME },
    jamendoClientId: env.JAMENDO_CLIENT_ID,
    listenBrainzToken: env.LISTENBRAINZ_TOKEN,
    listenBrainzSimilarArtists: env.LISTENBRAINZ_SIMILAR_ARTISTS,
    mbUserAgent: env.MB_USER_AGENT,
    usingDevSecrets,
  };
}
