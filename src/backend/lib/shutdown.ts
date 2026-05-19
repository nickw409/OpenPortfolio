import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

import { closeDb, type Db } from '@backend/db/client';
import type { ErrorEnvelope } from '@shared/errors';

import type { ServerState } from './server-state';

const HEALTH_PATH_PREFIX = '/api/v1/health';
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Gate middleware: short-circuits non-health requests when the server
 * is starting (migrations running) or shutting down (drain in progress).
 * /api/v1/health stays available so Electron / orchestrators can poll.
 */
export function createBootGate(state: ServerState): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith(HEALTH_PATH_PREFIX)) {
      return next();
    }
    if (state.phase === 'starting') {
      const envelope: ErrorEnvelope = {
        code: 'service.migrating',
        message: 'Backend is starting up',
      };
      return c.json(envelope, 503);
    }
    if (state.phase === 'shutting_down') {
      const envelope: ErrorEnvelope = {
        code: 'service.shutting_down',
        message: 'Backend is shutting down',
      };
      return c.json(envelope, 503);
    }
    return next();
  };
}

export interface ServerLike {
  close: (cb?: (err?: Error) => void) => void;
}

export interface RegisterShutdownOptions {
  state: ServerState;
  server: ServerLike;
  db: Db;
  logger: Logger;
  drainTimeoutMs?: number;
  /** Process exit fn (overridable for tests). Default: process.exit. */
  exit?: (code: number) => never;
}

/**
 * Wire SIGINT/SIGTERM to drain in-flight requests, close the DB, then
 * exit. http.Server.close() stops accepting new connections and waits
 * for existing ones; we cap the wait with drainTimeoutMs.
 */
export function registerShutdown(opts: RegisterShutdownOptions): void {
  const { state, server, db, logger } = opts;
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  let triggered = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (triggered) return;
    triggered = true;
    logger.info({ signal, drainTimeoutMs }, 'shutdown signal received');
    state.phase = 'shutting_down';

    const timer = setTimeout(() => {
      logger.warn({ drainTimeoutMs }, 'drain timeout exceeded, forcing exit');
      safelyCloseDb(db, logger);
      exit(1);
    }, drainTimeoutMs);
    // Timer must not keep the event loop alive on its own.
    timer.unref();

    server.close((err) => {
      clearTimeout(timer);
      if (err) {
        logger.error({ err }, 'server close error');
      }
      safelyCloseDb(db, logger);
      logger.info('shutdown complete');
      exit(err ? 1 : 0);
    });
  };

  process.once('SIGINT', () => handle('SIGINT'));
  process.once('SIGTERM', () => handle('SIGTERM'));
}

function safelyCloseDb(db: Db, logger: Logger): void {
  try {
    closeDb(db);
  } catch (err) {
    logger.error({ err }, 'db close error');
  }
}
