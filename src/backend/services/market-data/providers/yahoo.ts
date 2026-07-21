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

// Yahoo Finance chart API. This is an unofficial endpoint; v1.0 treats it as
// a zero-config fallback with clear degradation to cost-basis display. We use
// the v8 chart endpoint, which returns adjusted close prices in the
// `indicators.adjclose` array.

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

export class YahooProvider implements PriceProvider {
  readonly name = 'yahoo';

  constructor(private readonly fetcher: Fetcher) {}

  async getQuote(symbol: string): Promise<PriceQuote> {
    const today = dateToUtcMidnight(new Date());
    const history = await this.getHistory(symbol, { from: today, to: today });
    if (history.length === 0) {
      throw new MarketDataError(
        'price.unexpected_response',
        `Yahoo returned no quote data for ${symbol}`,
        502,
        { symbol, provider: this.name },
      );
    }
    return history[history.length - 1]!;
  }

  async getHistory(symbol: string, range: PriceHistoryRange): Promise<PriceQuote[]> {
    const from = isoDateString(range.from);
    const to = isoDateString(range.to);
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?period1=${isoToUnix(range.from)}&period2=${isoToUnix(
      range.to,
    )}&interval=1d&events=history&includeAdjustedClose=true`;

    const res = await this.fetcher(url);
    if (!res.ok) {
      throw new MarketDataError(
        'price.fetch_failed',
        `Yahoo request failed: HTTP ${res.status}`,
        502,
        { symbol, provider: this.name, status: res.status },
      );
    }

    const json = await res.json();
    const quotes = parseChartResponse(symbol, json);
    if (quotes.length === 0) {
      throw new MarketDataError(
        'price.unexpected_response',
        `Yahoo returned no price points for ${symbol} in ${from}..${to}`,
        502,
        { symbol, provider: this.name, range: { from, to } },
      );
    }
    return quotes;
  }
}

function isoToUnix(date: Date): number {
  return Math.floor(dateToUtcMidnight(date).getTime() / 1000);
}

function parseChartResponse(symbol: string, json: unknown): PriceQuote[] {
  if (!isObject(json) || !isObject(json.chart)) {
    throw new MarketDataError(
      'price.unexpected_response',
      'Yahoo response missing chart object',
      502,
      { symbol, provider: 'yahoo' },
    );
  }
  const chart = json.chart as Record<string, unknown>;
  const error = chart.error;
  if (isObject(error)) {
    throw new MarketDataError(
      'price.fetch_failed',
      `Yahoo chart error: ${error.description ?? JSON.stringify(error)}`,
      502,
      { symbol, provider: 'yahoo', yahoo_error: error },
    );
  }
  const resultArr = chart.result;
  if (!Array.isArray(resultArr) || resultArr.length === 0) {
    return [];
  }
  const result = resultArr[0];
  if (!isObject(result)) {
    throw new MarketDataError('price.unexpected_response', 'Yahoo result object malformed', 502, {
      symbol,
      provider: 'yahoo',
    });
  }
  const timestamps = result.timestamp;
  if (!Array.isArray(timestamps)) {
    throw new MarketDataError(
      'price.unexpected_response',
      'Yahoo response missing timestamp array',
      502,
      { symbol, provider: 'yahoo' },
    );
  }
  const indicators = isObject(result.indicators) ? result.indicators : {};
  // Yahoo v8 returns adjusted close in `indicators.adjclose` as an array
  // containing a single array of values; fall back to `quote.close` if absent.
  const adjcloseOuter = Array.isArray(indicators.adjclose) ? indicators.adjclose : [];
  const adjcloseArr = Array.isArray(adjcloseOuter[0]) ? adjcloseOuter[0] : [];
  const quote = isObject(indicators.quote) ? indicators.quote : {};
  const closeArr = Array.isArray(quote.close) ? quote.close : [];

  const quotes: PriceQuote[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (typeof ts !== 'number') continue;
    const adj = adjcloseArr[i] ?? closeArr[i];
    if (typeof adj !== 'number' || !Number.isFinite(adj)) continue;
    const date = dateToUtcMidnight(new Date(ts * 1000));
    quotes.push({
      symbol,
      close_cents: centsFromDollars(adj),
      quote_date: date,
      source: 'yahoo',
    });
  }
  return quotes;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
