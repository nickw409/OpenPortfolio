import { Hono } from 'hono';

import type { Db } from '@backend/db/client';

export interface HealthDeps {
  db: Db;
  startTimeMs: number;
  version: string;
}

export type HealthStatus = 'ok' | 'migrating' | 'degraded';

export interface HealthResponse {
  status: HealthStatus;
  version: string;
  db_version: string | null;
  uptime_ms: number;
}

export function createHealthRoute(deps: HealthDeps): Hono {
  return new Hono().get('/', (c) => {
    let dbVersion: string | null = null;
    let status: HealthStatus = 'ok';
    try {
      const row = deps.db.$client
        .prepare('SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
        .get() as { hash: string } | undefined;
      dbVersion = row?.hash ?? null;
    } catch {
      status = 'degraded';
    }

    const body: HealthResponse = {
      status,
      version: deps.version,
      db_version: dbVersion,
      uptime_ms: Date.now() - deps.startTimeMs,
    };
    return c.json(body);
  });
}
