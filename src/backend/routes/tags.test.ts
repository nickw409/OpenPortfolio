import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { createErrorHandler } from '@backend/lib/error-handler';
import { logger } from '@backend/lib/logger';
import { runMigrations } from '@backend/db/migrate';

import { createTagsRoute } from './tags';

describe('tags routes', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-rtag-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  function app(): Hono {
    const a = new Hono();
    a.onError(createErrorHandler(logger));
    a.route('/api/v1/tags', createTagsRoute({ db }));
    return a;
  }

  it('POST creates and GET lists a tag', async () => {
    const post = await app().request('/api/v1/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Core' }),
    });
    expect(post.status).toBe(201);
    const list = await app().request('/api/v1/tags');
    const body = (await list.json()) as { tags: { name: string }[] };
    expect(body.tags.map((t) => t.name)).toContain('Core');
  });
});
