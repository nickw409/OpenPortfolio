import type { Logger } from 'pino';

import { price_history } from '@backend/db/schema';
import type { Db } from '@backend/db/client';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import type { Money } from '@shared/money';

import { dateToUtcMidnight, isoDateString, type PriceHistoryRange, type PriceQuote } from './types';

export interface PriceCacheDeps {
  db: Db;
  logger: Logger;
}

export class PriceCache {
  constructor(private readonly deps: PriceCacheDeps) {}

  async getPrice(securityId: number, asOf: Date): Promise<PriceQuote | null> {
    const date = dateToUtcMidnight(asOf);
    const row = this.deps.db
      .select()
      .from(price_history)
      .where(and(eq(price_history.security_id, securityId), eq(price_history.price_date, date)))
      .get();
    if (!row) return null;
    return rowToQuote(row);
  }

  async getLatestPrice(securityId: number): Promise<PriceQuote | null> {
    const row = this.deps.db
      .select()
      .from(price_history)
      .where(eq(price_history.security_id, securityId))
      .orderBy(desc(price_history.price_date))
      .limit(1)
      .get();
    if (!row) return null;
    return rowToQuote(row);
  }

  async getHistory(securityId: number, range: PriceHistoryRange): Promise<PriceQuote[]> {
    const from = dateToUtcMidnight(range.from);
    const to = dateToUtcMidnight(range.to);
    const rows = this.deps.db
      .select()
      .from(price_history)
      .where(
        and(
          eq(price_history.security_id, securityId),
          gte(price_history.price_date, from),
          lte(price_history.price_date, to),
        ),
      )
      .orderBy(price_history.price_date)
      .all();
    return rows.map(rowToQuote);
  }

  async upsert(quotes: PriceQuote[], securityId: number): Promise<void> {
    if (quotes.length === 0) return;
    const mapped = quotes.map((q) => ({
      security_id: securityId,
      price_date: dateToUtcMidnight(q.quote_date),
      close_cents: q.close_cents,
      source: q.source,
      fetched_at: new Date(),
    }));
    // Drizzle SQLite has onConflictDoUpdate in beta; use raw prepared upsert for stability.
    const stmt = this.deps.db.$client.prepare(
      `INSERT INTO price_history (security_id, price_date, close_cents, source, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(security_id, price_date) DO UPDATE SET
         close_cents = excluded.close_cents,
         source = excluded.source,
         fetched_at = excluded.fetched_at`,
    );
    for (const m of mapped) {
      stmt.run(
        m.security_id,
        m.price_date.getTime(),
        m.close_cents,
        m.source,
        m.fetched_at.getTime(),
      );
    }
  }

  async getMissingDates(securityId: number, range: PriceHistoryRange): Promise<Date[]> {
    const from = dateToUtcMidnight(range.from);
    const to = dateToUtcMidnight(range.to);
    const existing = await this.getHistory(securityId, { from, to });
    const existingSet = new Set(existing.map((q) => isoDateString(q.quote_date)));
    const missing: Date[] = [];
    for (let d = new Date(from); d.getTime() <= to.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
      if (!existingSet.has(isoDateString(d))) {
        missing.push(new Date(d));
      }
    }
    return missing;
  }
}

function rowToQuote(row: {
  security_id: number;
  price_date: Date;
  close_cents: Money;
  source: string;
}): PriceQuote {
  return {
    symbol: String(row.security_id),
    close_cents: row.close_cents,
    quote_date: row.price_date,
    source: row.source,
  };
}

export function daysBetween(a: Date, b: Date): number {
  const ms = dateToUtcMidnight(b).getTime() - dateToUtcMidnight(a).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(dateToUtcMidnight(date));
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}
