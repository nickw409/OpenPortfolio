# Request/response logging middleware — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hono request/response logging middleware to satisfy WS2 spec T5 ("route hits, lifecycle" at info; "request/response bodies" at debug). Final remaining WS2 work before marking the workstream complete.

**Architecture:** A single Hono middleware factory `createRequestLogger(logger)` mounted before `bootGate` in `src/backend/index.ts`. Wraps `next()` in try/finally; emits one structured log line per completed request with method/path/status/duration; at debug level additionally captures cloned request and response bodies. Skips `/api/v1/health` to avoid Electron polling spam.

**Tech stack:** Hono (`MiddlewareHandler`), pino (existing `logger` instance), vitest, Node `Request.clone()` for body-peeking without consuming the original stream.

---

## File structure

- **Create:** `src/backend/lib/request-logger.ts` — middleware factory (~60–90 LOC)
- **Create:** `src/backend/lib/request-logger.test.ts` — vitest tests with captured pino sink (~100 LOC)
- **Modify:** `src/backend/index.ts` — mount middleware before bootGate
- **Modify:** `docs/WORKSTREAMS.md` — flip WS2 to Complete, list deferred-to-other-workstreams items

---

## Task 1: Middleware with full test coverage (TDD)

**Files:**
- Create: `src/backend/lib/request-logger.ts`
- Create: `src/backend/lib/request-logger.test.ts`

### Step 1.1: Write failing test — info-level shape on 2xx

- [ ] Create `src/backend/lib/request-logger.test.ts`:

```typescript
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
    expect(typeof requestLogs[0].duration_ms).toBe('number');
    expect(requestLogs[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
});
```

### Step 1.2: Run test, verify FAIL

- [ ] Run: `pnpm exec vitest run src/backend/lib/request-logger.test.ts`
- [ ] Expected: FAIL with "Cannot find module './request-logger'"

### Step 1.3: Minimal implementation (just the failing test)

- [ ] Create `src/backend/lib/request-logger.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

const HEALTH_PATH_PREFIX = '/api/v1/health';

export function createRequestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith(HEALTH_PATH_PREFIX)) {
      return next();
    }

    const start = performance.now();
    try {
      await next();
    } finally {
      const durationMs = performance.now() - start;
      const status = c.res?.status ?? 0;
      const contentLengthHeader = c.res?.headers.get('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
      logger.info(
        {
          method: c.req.method,
          path: c.req.path,
          status,
          duration_ms: Math.round(durationMs * 1000) / 1000,
          content_length: contentLength,
        },
        'request',
      );
    }
  };
}
```

### Step 1.4: Run test, verify PASS

- [ ] Run: `pnpm exec vitest run src/backend/lib/request-logger.test.ts`
- [ ] Expected: PASS

### Step 1.5: Add test — `/health` is skipped

- [ ] Append to `src/backend/lib/request-logger.test.ts` inside the describe block:

```typescript
  it('skips /api/v1/health to avoid Electron polling spam', async () => {
    const { logger, entries } = captureLogger('info');
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    app.get('/api/v1/health', (c) => c.json({ status: 'ok' }));

    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(entries.filter((e) => e.msg === 'request')).toHaveLength(0);
  });
```

- [ ] Run: `pnpm exec vitest run src/backend/lib/request-logger.test.ts`
- [ ] Expected: PASS (skip behavior already implemented in 1.3)

### Step 1.6: Add test — logs 503 path (middleware mounted before bootGate)

- [ ] Append to the describe block:

```typescript
  it('logs requests that downstream middleware short-circuits with 503', async () => {
    const { logger, entries } = captureLogger('info');
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    // Simulate bootGate short-circuit during shutdown:
    app.use('*', async (c) =>
      c.json({ code: 'service.shutting_down', message: 'draining' }, 503),
    );
    app.get('/api/v1/accounts', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/accounts');
    expect(res.status).toBe(503);
    const requestLogs = entries.filter((e) => e.msg === 'request');
    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0]).toMatchObject({ status: 503, path: '/api/v1/accounts' });
  });
```

- [ ] Run: `pnpm exec vitest run src/backend/lib/request-logger.test.ts`
- [ ] Expected: PASS (try/finally already handles this)

### Step 1.7: Failing test — debug-level captures request and response bodies

- [ ] Append to the describe block:

```typescript
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
    expect(requestLogs[0].request_body).toEqual({ hello: 'world' });
    expect(requestLogs[0].response_body).toEqual({ echoed: { hello: 'world' } });
  });
```

### Step 1.8: Run, verify FAIL

- [ ] Run: `pnpm exec vitest run src/backend/lib/request-logger.test.ts -t "debug-level"`
- [ ] Expected: FAIL — `request_body` and `response_body` are undefined

### Step 1.9: Add body capture for debug level

- [ ] Replace `src/backend/lib/request-logger.ts` contents:

```typescript
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
```

### Step 1.10: Run, verify PASS

- [ ] Run: `pnpm exec vitest run src/backend/lib/request-logger.test.ts`
- [ ] Expected: ALL PASS (4 tests)

### Step 1.11: Add test — streaming response logs `[stream]` placeholder

- [ ] Append to the describe block:

```typescript
  it('logs streaming responses as [stream] placeholder at debug level', async () => {
    const { logger, entries } = captureLogger('debug');
    const app = new Hono();
    app.use('*', createRequestLogger(logger));
    app.get('/api/v1/stream', (c) => {
      return new Response('chunk1\nchunk2\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const res = await app.request('/api/v1/stream');
    expect(res.status).toBe(200);

    const requestLogs = entries.filter((e) => e.msg === 'request');
    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0].response_body).toBe('[stream]');
  });
```

- [ ] Run: `pnpm exec vitest run src/backend/lib/request-logger.test.ts`
- [ ] Expected: PASS

### Step 1.12: Add test — redaction passes through

- [ ] Append to the describe block:

```typescript
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
    const body = requestLogs[0].request_body as { api_key: string; other: string };
    expect(body.api_key).toBe('[REDACTED]');
    expect(body.other).toBe('visible');
  });
```

- [ ] Run: `pnpm exec vitest run src/backend/lib/request-logger.test.ts`
- [ ] Expected: ALL 6 PASS

### Step 1.13: Lint clean

- [ ] Run: `pnpm exec eslint src/backend/lib/request-logger.ts src/backend/lib/request-logger.test.ts`
- [ ] Expected: no errors

### Step 1.14: Commit

```bash
git add src/backend/lib/request-logger.ts src/backend/lib/request-logger.test.ts
git commit -m "feat(backend): request/response logging middleware

Hono middleware logs one structured info line per completed request
(method, path, status, duration_ms, content_length). At debug level
additionally captures cloned request and response bodies; streaming
content-types log a [stream] placeholder. Skips /api/v1/health to
avoid Electron polling spam. Body fields flow through pino's redact
paths so future API keys are scrubbed centrally.

Closes the last WS2 spec T5 item."
```

---

## Task 2: Wire middleware into backend entrypoint

**Files:**
- Modify: `src/backend/index.ts` (mount before bootGate)

### Step 2.1: Edit `src/backend/index.ts`

Current imports already include `logger` and `createBootGate`. Insert the request-logger import and mount it **before** `createBootGate`.

- [ ] Modify `src/backend/index.ts`:

  Add to imports (alphabetical with the others):

```typescript
import { createRequestLogger } from '@backend/lib/request-logger';
```

  Replace the middleware-wiring block:

```typescript
const app = new Hono();
app.use('*', createBootGate(state));
app.onError(createErrorHandler(logger));
```

  With:

```typescript
const app = new Hono();
app.use('*', createRequestLogger(logger));
app.use('*', createBootGate(state));
app.onError(createErrorHandler(logger));
```

### Step 2.2: Verify the full test suite passes

- [ ] Run: `pnpm exec vitest run`
- [ ] Expected: all tests pass (no regressions in boot, shutdown, health, error-handler suites)

### Step 2.3: Verify lint and typecheck

- [ ] Run: `pnpm exec eslint .`
- [ ] Expected: no errors
- [ ] Run: `pnpm exec tsc --noEmit`
- [ ] Expected: no errors

### Step 2.4: Commit

```bash
git add src/backend/index.ts
git commit -m "feat(backend): mount request logger before bootGate

Mounted upstream of createBootGate so 503 service.migrating /
service.shutting_down responses are still observable in logs."
```

---

## Task 3: Mark WS2 complete in WORKSTREAMS.md

**Files:**
- Modify: `docs/WORKSTREAMS.md` (WS2 section)

### Step 3.1: Update WS2 status and remaining list

- [ ] Edit `docs/WORKSTREAMS.md` §2:

  Change the status line from:

```markdown
**Status: In progress.** Skeleton, boot orchestration, error envelope, logging, health, and shutdown all landed. Route groups beyond `/health` are not yet wired — they arrive alongside the features that need them (data ingestion in W5, calculations surface in W3/W7). See [specs/2026-05-18-backend-api-design.md](specs/2026-05-18-backend-api-design.md) for the design decisions (T1–T6).
```

  to:

```markdown
**Status: Complete.** Backend skeleton, boot orchestration, error envelope, structured logging, request/response middleware, health, and shutdown all landed against spec T1–T6 ([specs/2026-05-18-backend-api-design.md](specs/2026-05-18-backend-api-design.md)). Per-feature route groups land with the consuming workstreams (W3/W5/W7); file-sink rotation and dev CORS land with W11 and W4 respectively — these are spec-deferred, not WS2 work.
```

  Add a new bullet under "Landed:" (before the closing of that section):

```markdown
- [x] Request/response logging middleware ([src/backend/lib/request-logger.ts](../src/backend/lib/request-logger.ts)): info-level per-request line, debug-level body capture, `/health` skip, mounted before `bootGate` so 503 paths log (T5)
```

  Replace the entire "Remaining:" block with:

```markdown
Deferred to dependent workstreams (spec-aligned, not WS2 backlog):
- Per-feature route groups (`/accounts`, `/transactions`, `/positions`, `/returns`) — land alongside W3/W5/W7 as their UIs need them
- File-sink log rotation (`pino-roll` to `<userData>/logs/`) — needs Electron's `userData` (W11)
- Dev-mode CORS allowlist for the Vite dev origin — wired with W4 frontend bootstrap
- Optional loopback auth token — deferred to W11 review per spec open questions
```

### Step 3.2: Commit

```bash
git add docs/WORKSTREAMS.md
git commit -m "docs(workstreams): mark WS2 backend API complete

All in-scope WS2 items shipped (skeleton, boot orchestration, error
envelope, pino logging, request/response middleware, health,
shutdown). Items that the spec defers to W4/W11/consuming
workstreams listed explicitly so they're not lost."
```

---

## Self-review

**Spec coverage (against `docs/specs/2026-05-18-backend-api-design.md` §T5):**
- T5 calls for `info` (route hits, lifecycle) and `debug` (request/response bodies). ✓ Task 1 implements both.
- T5 requires API-key redaction via a serializer. ✓ Step 1.12 verifies pino's `redact` flows through body fields.
- T5 privacy invariant: local-only, no remote sinks. ✓ Middleware uses the existing `logger` instance, which has no remote transport.

**Placeholder scan:** no TBDs, no "implement appropriately", every step shows the exact code or command.

**Type consistency:** `createRequestLogger(logger: Logger)` signature consistent across plan; `MiddlewareHandler` import from `hono` matches existing code (`shutdown.ts:1`).

**Scope check:** single file + wiring + doc update. Tight scope, no decomposition needed.

**Ambiguity check:** body-capture failure mode is defined (returns `undefined` via the safe-read helpers) so the middleware never throws on malformed bodies. Streaming detection uses content-type, not a heuristic.

---

## Execution handoff

Plan complete and saved. Per `feedback_prefer_inline_execution.md`, defaulting to **inline execution** via superpowers:executing-plans rather than offering the choice.
