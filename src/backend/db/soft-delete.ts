import { and, getTableColumns, isNull, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { Db } from './client';

export const SOFT_DELETE_COLUMNS = ['created_at', 'updated_at', 'deleted_at'] as const;

function deletedAtColumn(table: SQLiteTable): SQLiteColumn {
  const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
  const col = cols.deleted_at;
  if (!col) throw new Error(`table ${String(table)} has no deleted_at column`);
  return col;
}

export function activeFilter(table: SQLiteTable): SQL {
  return isNull(deletedAtColumn(table));
}

export function activeWhere(table: SQLiteTable, predicate: SQL | undefined): SQL {
  const f = activeFilter(table);
  if (!predicate) return f;
  const combined = and(predicate, f);
  if (!combined) throw new Error('and() returned undefined');
  return combined;
}

export function softDelete(db: Db, table: SQLiteTable, predicate: SQL): number {
  const now = new Date();
  const result = db
    .update(table)
    .set({ deleted_at: now, updated_at: now })
    .where(activeWhere(table, predicate))
    .run();
  return result.changes;
}

/**
 * Returns a list of missing soft-delete columns for any table in the given
 * map. Used by the schema-invariant test in soft-delete.test.ts.
 */
export function listSoftDeleteViolations(tables: Record<string, SQLiteTable>): string[] {
  const violations: string[] = [];
  for (const [name, table] of Object.entries(tables)) {
    const cols = getTableColumns(table) as Record<string, unknown>;
    for (const col of SOFT_DELETE_COLUMNS) {
      if (!(col in cols)) violations.push(`${name}: missing ${col}`);
    }
  }
  return violations;
}
