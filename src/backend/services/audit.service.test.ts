import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { audit_log } from '@backend/db/schema';

import { writeAudit } from './audit.service';

describe('writeAudit', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-audit-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });
  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('records an insert row with serialized after-state', () => {
    writeAudit(db, {
      entity_type: 'transaction',
      entity_id: 7,
      action: 'insert',
      after: { id: 7, quantity: 3 },
    });
    const rows = db.select().from(audit_log).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('insert');
    expect(rows[0]!.entity_id).toBe(7);
    expect(rows[0]!.before_json).toBeNull();
    expect(JSON.parse(rows[0]!.after_json!)).toEqual({ id: 7, quantity: 3 });
  });
});
