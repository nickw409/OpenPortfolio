import type { Db } from '@backend/db/client';
import { audit_log } from '@backend/db/schema';

export type AuditAction = 'insert' | 'update' | 'delete';

export interface WriteAuditParams {
  entity_type: string;
  entity_id: number;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
}

export function writeAudit(db: Db, p: WriteAuditParams): void {
  db.insert(audit_log).values({
    entity_type: p.entity_type,
    entity_id: p.entity_id,
    action: p.action,
    before_json: p.before === undefined ? null : JSON.stringify(p.before),
    after_json: p.after === undefined ? null : JSON.stringify(p.after),
    actor: 'user',
  }).run();
}
