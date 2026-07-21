import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { createDb } from '@backend/db/client';
import { runBoot } from '@backend/lib/boot';
import { createErrorHandler } from '@backend/lib/error-handler';
import { logger } from '@backend/lib/logger';
import { createRequestLogger } from '@backend/lib/request-logger';
import { createServerState } from '@backend/lib/server-state';
import { createBootGate, registerShutdown } from '@backend/lib/shutdown';
import { VERSION } from '@backend/lib/version';
import { createAccountsRoute } from '@backend/routes/accounts';
import { createHealthRoute } from '@backend/routes/health';
import { createPricesRoute } from '@backend/routes/prices';
import { createCpiRoute } from '@backend/routes/cpi';
import { priceProviderConfigFromEnv } from '@backend/services/market-data/provider-registry';

const db = createDb();
const state = createServerState();

const app = new Hono();
app.use('*', createRequestLogger(logger));
app.use('*', createBootGate(state));
app.onError(createErrorHandler(logger));
app.route('/api/v1/health', createHealthRoute({ db, state, version: VERSION }));
app.route('/api/v1/accounts', createAccountsRoute({ db }));
app.route('/api/v1/prices', createPricesRoute({ db, state, config: priceProviderConfigFromEnv() }));
app.route('/api/v1/cpi', createCpiRoute({ db, state }));

const port = Number(process.env.PORT ?? 8787);
// Loopback only — see docs/specs/2026-05-18-backend-api-design.md §T1.
const hostname = '127.0.0.1';

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  logger.info({ port: info.port, pid: process.pid, hostname }, 'backend listening');
});

registerShutdown({ state, server, db, logger });

// Boot runs after the server is already listening so /api/v1/health
// can report `migrating` during the backup+migrate window. Non-health
// routes are gated by the boot middleware until state.phase === 'ready'.
runBoot({ db, state, logger }).catch((err) => {
  logger.fatal({ err }, 'boot failed, exiting');
  process.exit(1);
});
