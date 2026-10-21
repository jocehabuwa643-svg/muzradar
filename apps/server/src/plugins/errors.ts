import type { FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

/** Ошибка API с машинным кодом; тело ответа совпадает с `ApiError` из shared. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const httpError = {
  badRequest: (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details),
  unauthorized: (message = 'Нужна авторизация') => new HttpError(401, 'unauthorized', message),
  forbidden: (code: string, message: string) => new HttpError(403, code, message),
  notFound: (code = 'not_found', message = 'Не найдено') => new HttpError(404, code, message),
  conflict: (code: string, message: string) => new HttpError(409, code, message),
  unprocessable: (code: string, message: string, details?: unknown) => new HttpError(422, code, message, details),
  unavailable: (code: string, message: string) => new HttpError(503, code, message),
};

export default fp(
  async (app) => {
    app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
      if (hasZodFastifySchemaValidationErrors(err)) {
        return reply.code(400).send({ error: 'validation', message: 'Некорректные данные', details: err.validation });
      }
      if (err instanceof HttpError) {
        if (err.statusCode >= 500) req.log.error({ err }, err.message);
        return reply
          .code(err.statusCode)
          .send({ error: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) });
      }
      if (isResponseSerializationError(err)) {
        req.log.error({ err, issues: err.cause.issues }, 'response does not match schema');
        return reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка' });
      }
      const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
      if (status >= 500) {
        req.log.error({ err }, 'unhandled error');
        return reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка' });
      }
      const code = status === 429 ? 'rate_limited' : (err.code ?? 'error').toLowerCase();
      return reply.code(status).send({ error: code, message: err.message });
    });

    app.setNotFoundHandler((req, reply) => {
      reply.code(404).send({ error: 'not_found', message: `Нет маршрута ${req.method} ${req.url.split('?')[0]}` });
    });
  },
  { name: 'errors' },
);
