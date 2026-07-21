// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiGet } from './api';

describe('apiGet', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns parsed JSON on 2xx', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await apiGet<{ ok: boolean }>('/api/v1/test');
    expect(result).toEqual({ ok: true });
  });

  it('throws ApiError with parsed envelope on 4xx', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: 'not_found', message: 'no such thing', context: { id: 42 } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(apiGet('/api/v1/missing')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'not_found',
      message: 'no such thing',
      context: { id: 42 },
      status: 404,
    });
  });

  it('throws ApiError with synthetic envelope when body is not JSON', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('upstream is on fire', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const err = await apiGet('/api/v1/boom').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('network.unexpected_response');
    expect((err as ApiError).status).toBe(500);
  });
});
