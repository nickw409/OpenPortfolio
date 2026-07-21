import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';

import { createTag, listTags } from './tags.service';

describe('tags.service', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-tag-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and lists a tag', () => {
    createTag(db, { name: 'Roth' });
    const tags = listTags(db);
    expect(tags.map((t: { name: string }) => t.name)).toContain('Roth');
  });
});
