import type { Logger } from 'pino';

import { eq } from 'drizzle-orm';

import { securities } from '@backend/db/schema';
import type { Db } from '@backend/db/client';
import type { Money } from '@shared/money';

import { PriceCache, addDays, daysBetween } from './price-cache';
import { RateLimiter, PROVIDER_RULES, type RateLimitRule } from './rate-limiter';
import {
  type Fetcher,
  type PriceHistoryRange,
  type PriceProvider,
  type PriceProviderConfig,
  type PriceQuote,
  dateToUtcMidnight,
} from './types';
import { createPriceProvider } from './provider-registry';
import { MarketDataError } from './errors';

export interface PriceServiceDeps {
  db: Db;
  logger: Logger;
  provider: PriceProvider | null;
  fetcher?: Fetcher;
}

export interface PriceWarning {
  code: 'price.stale' | 'price.no_provider' | 'price.no_price';
  security_id: number;
  symbol?: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface PriceServiceResult {
  quote: PriceQuote | null;
  warning: PriceWarning | null;
}

export interface HistoryServiceResult {
  quotes: PriceQuote[];
  warnings: PriceWarning[];
  fullyCovered: boolean;
}

export class PriceService {
  private readonly cache: PriceCache;
  private readonly rateLimiter: RateLimiter;

  constructor(private readonly deps: PriceServiceDeps) {
    this.cache = new PriceCache({ db: deps.db, logger: deps.logger });
    this.rateLimiter = new RateLimiter(deps.db);
  }

  static fromConfig(
    db: Db,
    logger: Logger,
    config: PriceProviderConfig | null,
    fetcher?: Fetcher,
  ): PriceService {
    const provider = config ? createPriceProvider(config, fetcher) : null;
    return new PriceService({ db, logger, provider, fetcher });
  }

  async getLatestPrice(
    securityId: number,
    opts: { maxStalenessDays?: number; symbol?: string } = {},
  ): Promise<PriceServiceResult> {
    const maxStalenessDays = opts.maxStalenessDays ?? 7;
    const symbol = opts.symbol ?? (await this.resolveSymbol(securityId));
    const cached = await this.cache.getLatestPrice(securityId);

    if (cached) {
      const ageDays = daysBetween(cached.quote_date, new Date());
      if (ageDays <= maxStalenessDays) {
        return { quote: cached, warning: null };
      }
      if (this.deps.provider) {
        try {
          await this.refreshQuote(symbol, securityId);
          const fresh = await this.cache.getLatestPrice(securityId);
          if (fresh) {
            const freshAge = daysBetween(fresh.quote_date, new Date());
            if (freshAge <= maxStalenessDays) {
              return { quote: fresh, warning: null };
            }
          }
        } catch (err) {
          this.deps.logger.warn({ err, securityId, symbol }, 'failed to refresh stale price');
        }
      }
      const warning: PriceWarning = {
        code: 'price.stale',
        security_id: securityId,
        symbol,
        message: `Price for ${symbol} is ${ageDays} days old`,
        context: {
          last_price_date: cached.quote_date,
          age_days: ageDays,
          max_staleness_days: maxStalenessDays,
        },
      };
      return { quote: cached, warning };
    }

    if (this.deps.provider) {
      try {
        const quote = await this.refreshQuote(symbol, securityId);
        return { quote, warning: null };
      } catch (err) {
        this.deps.logger.warn({ err, securityId, symbol }, 'failed to fetch price');
      }
    }

    const code: PriceWarning['code'] = this.deps.provider ? 'price.no_price' : 'price.no_provider';
    const message = this.deps.provider
      ? `No price available for ${symbol}`
      : `No price provider configured for ${symbol}`;
    return {
      quote: null,
      warning: { code, security_id: securityId, symbol, message },
    };
  }

  async getPriceHistory(
    securityId: number,
    range: PriceHistoryRange,
    opts: { symbol?: string } = {},
  ): Promise<HistoryServiceResult> {
    const symbol = opts.symbol ?? (await this.resolveSymbol(securityId));
    const from = dateToUtcMidnight(range.from);
    const to = dateToUtcMidnight(range.to);
    let quotes = await this.cache.getHistory(securityId, { from, to });

    if (this.deps.provider) {
      const missing = await this.cache.getMissingDates(securityId, { from, to });
      if (missing.length > 0) {
        try {
          const fetched = await this.fetchWithRateLimit(symbol, securityId, { from, to });
          const manualSet = new Set(
            quotes.filter((q) => q.source === 'manual').map((q) => q.quote_date.getTime()),
          );
          const merged = mergeQuotes(quotes, fetched).filter(
            (q) => q.source === 'manual' || !manualSet.has(q.quote_date.getTime()),
          );
          quotes = merged;
        } catch (err) {
          this.deps.logger.warn(
            { err, securityId, symbol, range: { from, to } },
            'failed to fetch price history',
          );
        }
      }
    }

    const warnings: PriceWarning[] = [];
    const expectedDays = daysBetween(from, to) + 1;
    const fullyCovered = quotes.length >= expectedDays;
    if (!fullyCovered && !this.deps.provider) {
      warnings.push({
        code: 'price.no_provider',
        security_id: securityId,
        symbol,
        message: `No price provider configured; history for ${symbol} is incomplete`,
      });
    }

    return { quotes, warnings, fullyCovered };
  }

  async refreshQuote(symbol: string, securityId: number): Promise<PriceQuote> {
    if (!this.deps.provider) {
      throw new MarketDataError('price.no_provider', 'No price provider configured', 400, {
        symbol,
        security_id: securityId,
      });
    }
    const today = dateToUtcMidnight(new Date());
    const quote = await this.fetchWithRateLimit(symbol, securityId, { from: today, to: today });
    if (quote.length === 0) {
      throw new MarketDataError('price.no_price', `No price returned for ${symbol}`, 404, {
        symbol,
        security_id: securityId,
      });
    }
    return quote[quote.length - 1]!;
  }

  async setManualPrice(securityId: number, date: Date, close_cents: Money): Promise<PriceQuote> {
    const symbol = await this.resolveSymbol(securityId);
    const quote: PriceQuote = {
      symbol,
      close_cents,
      quote_date: dateToUtcMidnight(date),
      source: 'manual',
    };
    await this.cache.upsert([quote], securityId);
    return quote;
  }

  private async fetchWithRateLimit(
    symbol: string,
    securityId: number,
    range: PriceHistoryRange,
  ): Promise<PriceQuote[]> {
    if (!this.deps.provider) return [];
    const rule = PROVIDER_RULES[this.deps.provider.name as 'yahoo' | 'polygon'];
    const effectiveRule: RateLimitRule = rule ?? {
      minIntervalMs: null,
      windowMax: null,
      windowMs: null,
    };
    const check = this.rateLimiter.check(this.deps.provider.name, effectiveRule);
    if (!check.allowed) {
      throw new MarketDataError(
        'price.rate_limited',
        `Rate limited for ${this.deps.provider.name}; next request at ${check.nextAllowedAt?.toISOString() ?? 'unknown'}`,
        429,
        { provider: this.deps.provider.name, next_allowed_at: check.nextAllowedAt },
      );
    }

    const requestedAt = new Date();
    let quotes: PriceQuote[];
    let success = false;
    try {
      quotes = await this.deps.provider.getHistory(symbol, range);
      success = true;
    } catch (err) {
      this.rateLimiter.record(this.deps.provider.name, 'getHistory', requestedAt, symbol, false);
      throw err;
    }
    this.rateLimiter.record(this.deps.provider.name, 'getHistory', requestedAt, symbol, success);
    await this.cache.upsert(quotes, securityId);
    return quotes;
  }

  private async resolveSymbol(securityId: number): Promise<string> {
    const row = this.deps.db
      .select({ symbol: securities.symbol })
      .from(securities)
      .where(eq(securities.id, securityId))
      .get();
    if (!row) {
      throw new MarketDataError('price.invalid_symbol', `Security ${securityId} not found`, 404, {
        security_id: securityId,
      });
    }
    return row.symbol;
  }
}

function mergeQuotes(existing: PriceQuote[], fetched: PriceQuote[]): PriceQuote[] {
  const map = new Map<number, PriceQuote>();
  for (const q of existing) {
    map.set(q.quote_date.getTime(), q);
  }
  for (const q of fetched) {
    // Manual prices take precedence.
    if (!map.has(q.quote_date.getTime()) || q.source === 'manual') {
      map.set(q.quote_date.getTime(), q);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.quote_date.getTime() - b.quote_date.getTime());
}

export { addDays, daysBetween };
