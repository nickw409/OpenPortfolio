import { Hono } from 'hono';

import type { Db } from '@backend/db/client';
import type { ServerState } from '@backend/lib/server-state';

export interface HealthDeps {
  db: Db;
  state: ServerState;
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
    let dbReachable = true;
    try {
      const row = deps.db.$client
        .prepare('SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
        .get() as { hash: string } | undefined;
      dbVersion = row?.hash ?? null;
    } catch {
      dbReachable = false;
    }

    const body: HealthResponse = {
      status: deriveStatus(deps.state.phase, dbReachable),
      version: deps.version,
      db_version: dbVersion,
      uptime_ms: Date.now() - deps.state.startedAt,
    };
    return c.json(body);
  });
}

function deriveStatus(phase: ServerState['phase'], dbReachable: boolean): HealthStatus {
  if (phase === 'starting') return 'migrating';
  if (phase === 'shutting_down' || phase === 'degraded' || !dbReachable) return 'degraded';
  return 'ok';
}
