import { Hono } from 'hono';
import pino, { type Logger } from 'pino';
import { z } from 'zod';

import { AppError } from '@shared/errors';

import { createErrorHandler } from './error-handler';

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

describe('createErrorHandler', () => {
  it('maps AppError to its envelope + status', async () => {
    const app = new Hono();
    app.onError(createErrorHandler(silentLogger()));
    app.get('/boom', () => {
      throw new AppError({
        code: 'not_found.resource',
        message: 'account 7 missing',
        status: 404,
        context: { resource: 'account', id: 7 },
      });
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: 'not_found.resource',
      message: 'account 7 missing',
      context: { resource: 'account', id: 7 },
    });
  });

  it('maps ZodError to validation.invalid_input with 400', async () => {
    const app = new Hono();
    app.onError(createErrorHandler(silentLogger()));
    app.get('/parse', () => {
      // Throwing the parse error reaches onError just like a validator would.
      z.object({ n: z.number() }).parse({ n: 'not a number' });
      return new Response();
    });

    const res = await app.request('/parse');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; context: { issues: unknown[] } };
    expect(body.code).toBe('validation.invalid_input');
    expect(Array.isArray(body.context.issues)).toBe(true);
  });

  it('maps unknown errors to internal.unknown with 500 and does not leak details', async () => {
    const app = new Hono();
    app.onError(createErrorHandler(silentLogger()));
    app.get('/crash', () => {
      throw new Error('secret implementation detail');
    });

    const res = await app.request('/crash');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('internal.unknown');
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('secret implementation detail');
  });
});
