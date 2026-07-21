import { and, eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { securities } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';

export type SecurityRow = typeof securities.$inferSelect;

export function findSecurityBySymbol(
  db: Db,
  symbol: string,
  exchange?: string,
): SecurityRow | undefined {
  const predicate = exchange
    ? and(eq(securities.symbol, symbol), eq(securities.exchange, exchange))
    : eq(securities.symbol, symbol);
  return db.select().from(securities).where(activeWhere(securities, predicate)).limit(1).get();
}

export interface ResolveSecurityOptions {
  exchange?: string;
  asset_class?: string;
}

export function resolveSecurity(
  db: Db,
  symbol: string,
  opts: ResolveSecurityOptions = {},
): { security: SecurityRow; created: boolean } {
  const existing = findSecurityBySymbol(db, symbol, opts.exchange);
  if (existing) return { security: existing, created: false };

  const security = db.insert(securities).values({
    symbol,
    exchange: opts.exchange ?? 'UNKNOWN',
    asset_class: opts.asset_class ?? 'equity',
  }).returning().get();
  return { security, created: true };
}
