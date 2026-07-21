import { ofDollars, type Money } from '@shared/money';

// Public types for the price-data subsystem. The provider abstraction lives
// at src/backend/services/market-data/types.ts; this file is the shared shape
// between providers, the cache, and the financial engine's PriceHistory.

export interface PriceQuote {
  symbol: string;
  close_cents: Money;
  quote_date: Date;
  source: string;
}

export interface PriceHistoryRange {
  from: Date;
  to: Date;
}

export interface PriceProvider {
  readonly name: string;
  getQuote(symbol: string): Promise<PriceQuote>;
  getHistory(symbol: string, range: PriceHistoryRange): Promise<PriceQuote[]>;
}

export type PriceProviderKind = 'yahoo' | 'polygon';

export interface PriceProviderConfig {
  kind: PriceProviderKind;
  apiKey?: string;
}

// Fetcher abstraction so tests and production can both inject a function
// with the same signature as global fetch.
export type Fetcher = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function centsFromDollars(dollars: number): Money {
  return ofDollars(dollars);
}

export function dateToUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isoDateString(date: Date): string {
  return dateToUtcMidnight(date).toISOString().slice(0, 10);
}
