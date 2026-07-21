import {
  centsFromDollars,
  dateToUtcMidnight,
  isoDateString,
  type Fetcher,
  type PriceHistoryRange,
  type PriceProvider,
  type PriceQuote,
} from '../types';
import { MarketDataError } from '../errors';

// Polygon.io aggregate (candle) API. Requires a user-supplied API key.
// Docs: https://polygon.io/docs/stocks/get_v2_aggs_ticker__stocksticker__range__multiplier___timespan___from___to

const POLYGON_BASE = 'https://api.polygon.io/v2/aggs/ticker';

export interface PolygonProviderConfig {
  apiKey: string;
}

export class PolygonProvider implements PriceProvider {
  readonly name = 'polygon';

  constructor(
    private readonly fetcher: Fetcher,
    private readonly apiKey: string,
  ) {}

  async getQuote(symbol: string): Promise<PriceQuote> {
    const today = dateToUtcMidnight(new Date());
    const history = await this.getHistory(symbol, { from: today, to: today });
    if (history.length === 0) {
      throw new MarketDataError(
        'price.unexpected_response',
        `Polygon returned no quote data for ${symbol}`,
        502,
        { symbol, provider: this.name },
      );
    }
    return history[history.length - 1]!;
  }

  async getHistory(symbol: string, range: PriceHistoryRange): Promise<PriceQuote[]> {
    const from = isoDateString(range.from);
    const to = isoDateString(range.to);
    const ticker = toPolygonTicker(symbol);
    const url = `${POLYGON_BASE}/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&apiKey=${encodeURIComponent(
      this.apiKey,
    )}`;

    const res = await this.fetcher(url);
    if (!res.ok) {
      throw new MarketDataError(
        'price.fetch_failed',
        `Polygon request failed: HTTP ${res.status}`,
        502,
        { symbol, provider: this.name, status: res.status },
      );
    }

    const json = await res.json();
    const quotes = parseAggregateResponse(symbol, json);
    if (quotes.length === 0) {
      throw new MarketDataError(
        'price.unexpected_response',
        `Polygon returned no price points for ${symbol} in ${from}..${to}`,
        502,
        { symbol, provider: this.name, range: { from, to } },
      );
    }
    return quotes;
  }
}

function toPolygonTicker(symbol: string): string {
  // Polygon uses X:XXX for crypto and C:XXX for forex; equities are plain.
  // v1.0 only supports equity-like securities, so we pass through.
  return symbol.toUpperCase();
}

function parseAggregateResponse(symbol: string, json: unknown): PriceQuote[] {
  if (!isObject(json)) {
    throw new MarketDataError(
      'price.unexpected_response',
      'Polygon response is not an object',
      502,
      { symbol, provider: 'polygon' },
    );
  }
  const status = json.status;
  if (status === 'ERROR') {
    throw new MarketDataError(
      'price.fetch_failed',
      `Polygon API error: ${json.error ?? JSON.stringify(json)}`,
      502,
      { symbol, provider: 'polygon', polygon_error: json },
    );
  }
  const results = json.results;
  if (!Array.isArray(results)) {
    return [];
  }

  const quotes: PriceQuote[] = [];
  for (const item of results) {
    if (!isObject(item)) continue;
    const ts = item.t;
    const close = item.c;
    if (typeof ts !== 'number' || typeof close !== 'number' || !Number.isFinite(close)) continue;
    const date = dateToUtcMidnight(new Date(ts));
    quotes.push({
      symbol,
      close_cents: centsFromDollars(close),
      quote_date: date,
      source: 'polygon',
    });
  }
  return quotes;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
