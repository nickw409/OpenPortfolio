import { Hono } from 'hono';
import pino, { type Logger } from 'pino';

import { createRequestLogger } from './request-logger';

interface CapturedLog {
  level: number;
  msg?: string;
  method?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
  content_length?: number;
  request_body?: unknown;
  response_body?: unknown;
}

function captureLogger(level: string): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const logger = pino(
    { level },
    {
      write(line: string) {
        entries.push(JSON.parse(line) as CapturedLog);
      },
    },
  );
  return { logger, entries };
}

describe('createRequestLogger', () => {
  it('logs a single info entry per completed 2xx request', async () => {
    const { logger, entries } = captureLogger('info');
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    app.get('/api/v1/accounts', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/accounts');
    expect(res.status).toBe(200);

    const requestLogs = entries.filter((e) => e.msg === 'request');
    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0]).toMatchObject({
      method: 'GET',
      path: '/api/v1/accounts',
      status: 200,
    });
    expect(typeof requestLogs[0]!.duration_ms).toBe('number');
    expect(requestLogs[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('skips /api/v1/health to avoid Electron polling spam', async () => {
    const { logger, entries } = captureLogger('info');
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    app.get('/api/v1/health', (c) => c.json({ status: 'ok' }));

    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(entries.filter((e) => e.msg === 'request')).toHaveLength(0);
  });

  it('logs requests that downstream middleware short-circuits with 503', async () => {
    const { logger, entries } = captureLogger('info');
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    // Simulate bootGate short-circuit during shutdown:
    app.use('*', async (c) => c.json({ code: 'service.shutting_down', message: 'draining' }, 503));
    app.get('/api/v1/accounts', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/accounts');
    expect(res.status).toBe(503);
    const requestLogs = entries.filter((e) => e.msg === 'request');
    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0]!).toMatchObject({ status: 503, path: '/api/v1/accounts' });
  });

  it('captures request and response bodies at debug level', async () => {
    const { logger, entries } = captureLogger('debug');
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    app.post('/api/v1/echo', async (c) => {
      const body = await c.req.json();
      return c.json({ echoed: body });
    });

    const res = await app.request('/api/v1/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: { hello: 'world' } });

    const requestLogs = entries.filter((e) => e.msg === 'request');
    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0]!.request_body).toEqual({ hello: 'world' });
    expect(requestLogs[0]!.response_body).toEqual({ echoed: { hello: 'world' } });
  });

  it('logs streaming responses as [stream] placeholder at debug level', async () => {
    const { logger, entries } = captureLogger('debug');
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    app.get('/api/v1/stream', () => {
      return new Response('chunk1\nchunk2\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const res = await app.request('/api/v1/stream');
    expect(res.status).toBe(200);

    const requestLogs = entries.filter((e) => e.msg === 'request');
    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0]!.response_body).toBe('[stream]');
  });

  it('respects pino redact paths on body fields', async () => {
    const entries: CapturedLog[] = [];
    const logger = pino(
      {
        level: 'debug',
        redact: { paths: ['request_body.api_key'], censor: '[REDACTED]' },
      },
      {
        write(line: string) {
          entries.push(JSON.parse(line) as CapturedLog);
        },
      },
    );
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    app.post('/api/v1/config', async (c) => c.json(await c.req.json()));

    await app.request('/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: 'secret-token', other: 'visible' }),
    });

    const requestLogs = entries.filter((e) => e.msg === 'request');
    expect(requestLogs).toHaveLength(1);
    const body = requestLogs[0]!.request_body as { api_key: string; other: string };
    expect(body.api_key).toBe('[REDACTED]');
    expect(body.other).toBe('visible');
  });
});
