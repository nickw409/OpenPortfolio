import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

const HEALTH_PATH_PREFIX = '/api/v1/health';
const STREAM_CONTENT_TYPES = ['text/event-stream'];

async function readJsonSafe(req: Request): Promise<unknown> {
  try {
    const cloned = req.clone();
    const text = await cloned.text();
    if (text.length === 0) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readResponseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  if (STREAM_CONTENT_TYPES.some((t) => contentType.includes(t))) {
    return '[stream]';
  }
  try {
    const cloned = res.clone();
    const text = await cloned.text();
    if (text.length === 0) return undefined;
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    return text;
  } catch {
    return undefined;
  }
}

export function createRequestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith(HEALTH_PATH_PREFIX)) {
      return next();
    }

    const debugEnabled = logger.isLevelEnabled('debug');
    const start = performance.now();
    const requestBody = debugEnabled ? await readJsonSafe(c.req.raw) : undefined;

    try {
      await next();
    } finally {
      const durationMs = performance.now() - start;
      const status = c.res?.status ?? 0;
      const contentLengthHeader = c.res?.headers.get('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
      const responseBody = debugEnabled && c.res ? await readResponseBody(c.res) : undefined;

      logger.info(
        {
          method: c.req.method,
          path: c.req.path,
          status,
          duration_ms: Math.round(durationMs * 1000) / 1000,
          content_length: contentLength,
          ...(debugEnabled ? { request_body: requestBody, response_body: responseBody } : {}),
        },
        'request',
      );
    }
  };
}
