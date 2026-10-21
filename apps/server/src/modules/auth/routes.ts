import { DeviceAuthRequest, DeviceAuthResponse } from '@muzradar/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { toMe } from '../me/mapper.ts';
import { authenticateDevice } from './service.ts';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/device',
    {
      // Ключ — IP (токена ещё нет). Щедро: за одним IP оператора (CGNAT) сидят тысячи абонентов.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: DeviceAuthRequest, response: { 200: DeviceAuthResponse } },
    },
    async (req) => {
      const session = await authenticateDevice(req.body, {
        db: app.db,
        config: app.config,
        now: new Date(app.now()),
        ip: req.ip,
      });
      const token = app.issueAccessToken({
        sub: session.user.id,
        did: session.deviceId,
        ob: session.user.onboardedAt != null,
      });
      return { ...token, isNew: session.isNew, restored: session.restored, me: toMe(session.user, app.config) };
    },
  );
};

export default routes;
