import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino, { type Logger } from 'pino';

import { createDb, type Db } from '@backend/db/client';

import { createServerState, type ServerState } from './server-state';
import { createBootGate, registerShutdown, type ServerLike } from './shutdown';

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

describe('createBootGate', () => {
  let app: Hono;
  let state: ServerState;

  beforeEach(() => {
    state = createServerState();
    app = new Hono();
    app.use('*', createBootGate(state));
    app.get('/api/v1/health', (c) => c.json({ status: 'pass-through' }));
    app.get('/api/v1/accounts', (c) => c.json({ accounts: [] }));
  });

  it('lets /api/v1/health through during starting', async () => {
    state.phase = 'starting';
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pass-through' });
  });

  it('503s non-health routes during starting with service.migrating', async () => {
    state.phase = 'starting';
    const res = await app.request('/api/v1/accounts');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('service.migrating');
  });

  it('503s non-health routes during shutting_down with service.shutting_down', async () => {
    state.phase = 'shutting_down';
    const res = await app.request('/api/v1/accounts');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('service.shutting_down');
  });

  it('lets requests through when phase is ready', async () => {
    state.phase = 'ready';
    const res = await app.request('/api/v1/accounts');
    expect(res.status).toBe(200);
  });
});

describe('registerShutdown', () => {
  let tmpDir: string;
  let db: Db;
  let state: ServerState;
  let server: ServerLike & { closeCalls: number };
  let exitCalls: number[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-shutdown-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    state = createServerState();
    state.phase = 'ready';
    exitCalls = [];
    server = {
      closeCalls: 0,
      close(cb) {
        this.closeCalls += 1;
        // Simulate immediate clean close.
        cb?.(undefined);
      },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  function fakeExit(code: number): never {
    exitCalls.push(code);
    // Throw to short-circuit any code-after-exit that real process.exit would
    // skip; the listener swallows it via the try around our handler? No, we
    // just record and never actually exit. Cast satisfies the `never` return.
    return undefined as never;
  }

  it('triggers server.close + db close on SIGTERM and exits 0', async () => {
    registerShutdown({ state, server, db, logger: silentLogger(), exit: fakeExit });
    process.emit('SIGTERM');
    // Allow the close callback (synchronous in our fake) + microtasks to run.
    await new Promise((r) => setImmediate(r));

    expect(server.closeCalls).toBe(1);
    expect(state.phase).toBe('shutting_down');
    expect(exitCalls).toEqual([0]);
    expect(db.$client.open).toBe(false);
  });

  it('is idempotent for repeat signals', async () => {
    registerShutdown({ state, server, db, logger: silentLogger(), exit: fakeExit });
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(server.closeCalls).toBe(1);
  });

  it('exits 1 when server.close errors', async () => {
    const erroringServer: ServerLike & { closeCalls: number } = {
      closeCalls: 0,
      close(cb) {
        this.closeCalls += 1;
        cb?.(new Error('listen socket already closed'));
      },
    };
    registerShutdown({
      state,
      server: erroringServer,
      db,
      logger: silentLogger(),
      exit: fakeExit,
    });
    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    expect(exitCalls).toEqual([1]);
  });
});
