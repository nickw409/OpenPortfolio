import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

import { AppError, type ErrorEnvelope } from '@shared/errors';

export function createErrorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof AppError) {
      logger.warn({ err, code: err.code, status: err.status, context: err.context }, err.message);
      return c.json(err.toEnvelope(), err.status as ContentfulStatusCode);
    }

    if (err instanceof ZodError) {
      logger.warn({ err, issues: err.issues }, 'request validation failed');
      const envelope: ErrorEnvelope = {
        code: 'validation.invalid_input',
        message: 'Request validation failed',
        context: { issues: err.issues },
      };
      return c.json(envelope, 400);
    }

    logger.error({ err }, 'unhandled error');
    const envelope: ErrorEnvelope = {
      code: 'internal.unknown',
      message: 'Internal server error',
    };
    return c.json(envelope, 500);
  };
}
