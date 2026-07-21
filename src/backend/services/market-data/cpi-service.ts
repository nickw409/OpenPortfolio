import type { Logger } from 'pino';

import { cpi_data } from '@backend/db/schema';
import type { Db } from '@backend/db/client';
import { eq, and, gte, lte, asc } from 'drizzle-orm';

import type { CpiPoint, CpiSeries, DateRange } from '@backend/financial/types';

import { MarketDataError } from './errors';
import { type Fetcher, dateToUtcMidnight } from './types';

// BLS public API v2. No API key required for small queries. We fetch the
// U.S. city average, all items, seasonally adjusted CPI-U series:
// CUUR0000SA0.
const DEFAULT_SERIES_ID = 'CUUR0000SA0';
const BLS_BASE = 'https://api.bls.gov/publicAPI/v2/timeseries/data';

export interface CpiServiceDeps {
  db: Db;
  logger: Logger;
  fetcher?: Fetcher;
}

export class CpiService {
  private readonly fetcher: Fetcher;

  constructor(private readonly deps: CpiServiceDeps) {
    this.fetcher = deps.fetcher ?? defaultFetcher;
  }

  async refreshMonthly(seriesId: string = DEFAULT_SERIES_ID): Promise<CpiPoint[]> {
    const endYear = new Date().getUTCFullYear();
    const startYear = endYear - 10;
    const url = `${BLS_BASE}/${encodeURIComponent(seriesId)}?startyear=${startYear}&endyear=${endYear}`;

    const res = await this.fetcher(url);
    if (!res.ok) {
      throw new MarketDataError(
        'cpi.fetch_failed',
        `BLS CPI request failed: HTTP ${res.status}`,
        502,
        { series_id: seriesId, status: res.status },
      );
    }

    const json = await res.json();
    const points = parseBlsResponse(seriesId, json);
    if (points.length === 0) {
      throw new MarketDataError(
        'cpi.unexpected_response',
        `BLS returned no CPI points for ${seriesId}`,
        502,
        { series_id: seriesId },
      );
    }

    await this.upsert(seriesId, points);
    this.deps.logger.info({ series_id: seriesId, count: points.length }, 'CPI series refreshed');
    return points;
  }

  async getSeries(seriesId: string = DEFAULT_SERIES_ID, range?: DateRange): Promise<CpiSeries> {
    const from = range ? startOfMonth(range.from) : new Date(Date.UTC(1970, 0, 1));
    const to = range ? endOfMonth(range.to) : new Date(8640000000000000);
    const rows = this.deps.db
      .select({ period_date: cpi_data.period_date, index_value: cpi_data.index_value })
      .from(cpi_data)
      .where(
        and(
          eq(cpi_data.series_id, seriesId),
          gte(cpi_data.period_date, from),
          lte(cpi_data.period_date, to),
        ),
      )
      .orderBy(asc(cpi_data.period_date))
      .all();
    return rows.map((r) => ({ date: r.period_date, index: r.index_value }));
  }

  async getLatestDate(seriesId: string = DEFAULT_SERIES_ID): Promise<Date | null> {
    const row = this.deps.db
      .select({ period_date: cpi_data.period_date })
      .from(cpi_data)
      .where(eq(cpi_data.series_id, seriesId))
      .orderBy(asc(cpi_data.period_date))
      .limit(1)
      .get();
    return row?.period_date ?? null;
  }

  private async upsert(seriesId: string, points: CpiPoint[]): Promise<void> {
    if (points.length === 0) return;
    const stmt = this.deps.db.$client.prepare(
      `INSERT INTO cpi_data (series_id, period_date, index_value, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(series_id, period_date) DO UPDATE SET
         index_value = excluded.index_value,
         fetched_at = excluded.fetched_at`,
    );
    const now = new Date();
    for (const p of points) {
      stmt.run(seriesId, p.date.getTime(), p.index, now.getTime());
    }
  }
}

function parseBlsResponse(seriesId: string, json: unknown): CpiPoint[] {
  const results = isObject(json) ? json.Results : undefined;
  const resultsObj = isObject(results) ? results : {};
  const seriesArr = Array.isArray(resultsObj.series) ? resultsObj.series : [];
  if (seriesArr.length === 0) {
    throw new MarketDataError(
      'cpi.unexpected_response',
      'BLS CPI response missing Results.series array',
      502,
      { series_id: seriesId, response_type: typeof json },
    );
  }
  const series = seriesArr[0];
  if (!isObject(series) || series.seriesID !== seriesId) {
    throw new MarketDataError(
      'cpi.unexpected_response',
      'BLS CPI response missing expected series',
      502,
      { series_id: seriesId },
    );
  }
  const data = series.data;
  if (!Array.isArray(data)) {
    throw new MarketDataError('cpi.unexpected_response', 'BLS CPI series missing data array', 502, {
      series_id: seriesId,
    });
  }

  const points: CpiPoint[] = [];
  for (const raw of data) {
    if (!isObject(raw)) continue;
    const year = Number(raw.year);
    const period = String(raw.period);
    const value = Number(raw.value);
    if (!Number.isFinite(year) || !Number.isFinite(value)) continue;
    if (!period.startsWith('M')) continue;
    const month = Number(period.slice(1));
    if (month < 1 || month > 12) continue;
    // BLS period_date convention: first day of the reference month.
    points.push({ date: new Date(Date.UTC(year, month - 1, 1)), index: value });
  }
  return points.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function startOfMonth(date: Date): Date {
  const d = dateToUtcMidnight(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(date: Date): Date {
  const d = dateToUtcMidnight(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

async function defaultFetcher(
  url: string,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  const res = await fetch(url);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
