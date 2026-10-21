import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { avatars } from '../../db/schema.ts';
import { httpError } from '../../plugins/errors.ts';

/** Файл адресуется хешем содержимого и никогда не меняется — кэш на год (CDN, клиент). */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((part) => {
    const tag = part.trim();
    return tag === '*' || tag === etag || tag === `W/${etag}`;
  });
}

const routes: FastifyPluginAsyncZod = async (app) => {
  async function serve(req: FastifyRequest, reply: FastifyReply, hash: string, variant: 'full' | 'map') {
    const column = variant === 'full' ? avatars.webp : avatars.mapWebp;
    // Даже на 304 идём в БД: удалённый аватар (удаление аккаунта) не должен подтверждаться кэшу.
    const [row] = await app.db.select({ data: column }).from(avatars).where(eq(avatars.hash, hash)).limit(1);
    if (!row) throw httpError.notFound('avatar_not_found', 'Аватар не найден');

    const etag = `"${hash}"`;
    reply.header('cache-control', CACHE_CONTROL).header('etag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.header('content-type', 'image/webp').header('x-content-type-options', 'nosniff').send(row.data);
  }

  app.get(
    '/:file',
    { schema: { params: z.object({ file: z.string().regex(/^[0-9a-f]{64}\.webp$/) }) } },
    async (req, reply) => serve(req, reply, req.params.file.slice(0, 64), 'full'),
  );

  app.get(
    '/:hash/map.webp',
    { schema: { params: z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) }) } },
    async (req, reply) => serve(req, reply, req.params.hash, 'map'),
  );
};

export default routes;
