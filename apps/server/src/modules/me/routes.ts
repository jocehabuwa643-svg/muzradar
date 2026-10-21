import {
  AvatarUploadRequest,
  AvatarUploadResponse,
  birthYearBounds,
  ConsentsInput,
  LIMITS,
  Me,
  ProfileInput,
  SessionResponse,
  Taste,
} from '@muzradar/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { avatars, consents, users, type TasteJson } from '../../db/schema.ts';
import { httpError } from '../../plugins/errors.ts';
import { avatarUrl } from '../../types.ts';
import { processAvatar } from './avatar.ts';
import { isCurrentVersion, resolveVisibility } from './consents.ts';
import { toMe } from './mapper.ts';
import { checkName } from './names.ts';
import { loadActiveUser, onboardingIncomplete, type OnboardingStep } from './users.ts';

const unique = <T>(items: readonly T[]) => [...new Set(items)];

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/', { onRequest: [app.authenticate], schema: { response: { 200: Me } } }, async (req) => {
    const user = await loadActiveUser(app.db, req.user.sub);
    return toMe(user, app.config);
  });

  app.put(
    '/consents',
    { onRequest: [app.authenticate], schema: { body: ConsentsInput, response: { 200: Me } } },
    async (req) => {
      const now = new Date(app.now());
      const { birthYear, consents: input } = req.body;

      // До записи чего-либо: год рождения несовершеннолетнего младше 16 не сохраняется.
      const bounds = birthYearBounds(now);
      if (birthYear > bounds.max) throw httpError.forbidden('age_restricted', `МУЗРАДАР доступен с ${LIMITS.minAge} лет`);
      if (birthYear < bounds.min) throw httpError.badRequest('bad_birth_year', 'Проверьте год рождения');
      if (!isCurrentVersion(input)) {
        throw httpError.conflict('consents_outdated', 'Документы обновились — обновите приложение и примите новую редакцию');
      }

      const scope = unique(input.dissemination.scope);
      const visibility = resolveVisibility(birthYear, scope, now);
      const userId = req.user.sub;
      const audit = { userId, deviceId: req.user.did, recordedAt: now, ip: req.ip };

      const user = await app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({ birthYear, consentsVersion: input.processing.version, visibility, updatedAt: now })
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .returning();
        if (!updated) throw httpError.unauthorized();
        // Журнал только дополняется: каждое принятие каждой редакции — отдельная строка.
        await tx.insert(consents).values([
          { ...audit, kind: 'processing', version: input.processing.version, acceptedAt: new Date(input.processing.acceptedAt) },
          {
            ...audit,
            kind: 'dissemination',
            version: input.dissemination.version,
            scope,
            acceptedAt: new Date(input.dissemination.acceptedAt),
          },
          { ...audit, kind: 'rules', version: input.rules.version, acceptedAt: new Date(input.rules.acceptedAt) },
        ]);
        return updated;
      });
      return toMe(user, app.config);
    },
  );

  app.put(
    '/avatar',
    {
      onRequest: [app.authenticate],
      bodyLimit: 24_000,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { body: AvatarUploadRequest, response: { 200: AvatarUploadResponse } },
    },
    async (req) => {
      const user = await loadActiveUser(app.db, req.user.sub);
      // Фото лица — персональные данные: без согласия на обработку сервер его не принимает.
      if (!user.consentsVersion) throw onboardingIncomplete(['consents']);

      const avatar = await processAvatar(req.body.imageBase64);
      const now = new Date(app.now());
      await app.db.transaction(async (tx) => {
        await tx
          .insert(avatars)
          .values({ hash: avatar.hash, webp: avatar.webp, mapWebp: avatar.mapWebp, bytes: avatar.webp.length, createdAt: now })
          .onConflictDoNothing({ target: avatars.hash });
        await tx.update(users).set({ avatarHash: avatar.hash, updatedAt: now }).where(eq(users.id, user.id));
      });
      return {
        avatarUrl: avatarUrl(app.config, avatar.hash, 'full'),
        mapAvatarUrl: avatarUrl(app.config, avatar.hash, 'map'),
        bytes: avatar.webp.length,
      };
    },
  );

  app.put(
    '/profile',
    { onRequest: [app.authenticate], schema: { body: ProfileInput, response: { 200: SessionResponse } } },
    async (req) => {
      const { name, taste } = req.body;
      if (checkName(name)) throw httpError.unprocessable('name_rejected', 'Это имя нельзя использовать, выберите другое');

      const user = await loadActiveUser(app.db, req.user.sub);
      const missing: OnboardingStep[] = [];
      if (!user.consentsVersion) missing.push('consents');
      if (!user.avatarHash) missing.push('avatar');
      if (missing.length > 0) throw onboardingIncomplete(missing);

      const now = new Date(app.now());
      const tasteJson: TasteJson = {
        genres: unique(taste.genres),
        moods: unique(taste.moods),
        artists: uniqueArtists(taste.artists),
      };
      // Повторы проходят схему по длине массива, но после их удаления минимумы могут не выполняться.
      if (!Taste.safeParse(tasteJson).success) {
        throw httpError.badRequest('bad_taste', `Выберите минимум ${LIMITS.tasteGenresMin} разных жанра`);
      }
      const [updated] = await app.db
        .update(users)
        .set({
          name,
          taste: tasteJson,
          // Первое завершение онбординга фиксируется навсегда; правки профиля его не сдвигают.
          onboardedAt: sql`coalesce(${users.onboardedAt}, ${now.toISOString()}::timestamptz)`,
          updatedAt: now,
        })
        .where(and(eq(users.id, user.id), isNull(users.deletedAt)))
        .returning();
      if (!updated) throw httpError.unauthorized();

      // Новый токен с ob=true открывает карту, музыку и реалтайм без ожидания истечения старого.
      const token = app.issueAccessToken({ sub: updated.id, did: req.user.did, ob: true });
      return { ...token, me: toMe(updated, app.config) };
    },
  );
};

/** Артист, выбранный из подсказок и найденный поиском, не должен считаться дважды. */
function uniqueArtists(artists: readonly string[]): string[] {
  const seen = new Set<string>();
  return artists.filter((a) => {
    const key = a.toLocaleLowerCase('ru');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default routes;
