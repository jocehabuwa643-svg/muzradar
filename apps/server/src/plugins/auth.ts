import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { httpError } from './errors.ts';

/** Claims access-токена: пользователь, устройство, пройден ли онбординг. */
export interface AccessClaims {
  sub: string;
  did: string;
  ob: boolean;
}

export interface VerifiedClaims extends AccessClaims {
  exp: number;
  iat: number;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims;
    user: VerifiedClaims;
  }
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module 'fastify' {
  interface FastifyInstance {
    /** Любой валидный токен (в том числе во время онбординга). */
    authenticate: PreHandler;
    /** Токен с пройденным онбордингом: карта, музыка, реалтайм. */
    requireOnboarded: PreHandler;
    issueAccessToken(claims: AccessClaims): { accessToken: string; expiresInSec: number };
    /** Синхронная проверка (для Socket.IO). Бросает на невалидном/просроченном токене. */
    verifyAccessToken(token: string): VerifiedClaims;
  }
}

const ISSUER = 'muzradar';
const AUDIENCE = 'muzradar-app';

export default fp<{ secret: string; ttlSec: number }>(
  async (app, opts) => {
    await app.register(jwt, {
      secret: opts.secret,
      // @fastify/jwt сам переводит число секунд в миллисекунды (convertToMs)
      sign: { algorithm: 'HS256', expiresIn: opts.ttlSec, iss: ISSUER, aud: AUDIENCE },
      verify: { allowedIss: ISSUER, allowedAud: AUDIENCE, algorithms: ['HS256'] },
    });

    const verifyRequest = async (req: FastifyRequest) => {
      try {
        await req.jwtVerify();
      } catch {
        throw httpError.unauthorized();
      }
    };

    app.decorate('authenticate', async (req: FastifyRequest) => {
      await verifyRequest(req);
    });

    app.decorate('requireOnboarded', async (req: FastifyRequest) => {
      await verifyRequest(req);
      if (!req.user.ob) throw httpError.forbidden('onboarding_required', 'Сначала завершите онбординг');
    });

    app.decorate('issueAccessToken', (claims: AccessClaims) => ({
      accessToken: app.jwt.sign({ sub: claims.sub, did: claims.did, ob: claims.ob }),
      expiresInSec: opts.ttlSec,
    }));

    app.decorate('verifyAccessToken', (token: string) => app.jwt.verify<VerifiedClaims>(token));
  },
  { name: 'auth' },
);
