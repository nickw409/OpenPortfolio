import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, closeDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { createLogger } from '@backend/lib/logger';

import { CpiService } from './cpi-service';
import { isoDateString } from './types';

const logger = createLogger({ level: 'silent' });

function makeFetcher(response: unknown): import('./types').Fetcher {
  return async () => ({ ok: true, status: 200, json: async () => response });
}

describe('CpiService', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-cpi-test-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fetches and stores BLS CPI series', async () => {
    const response = {
      status: 'REQUEST_SUCCEEDED',
      responseTime: 0,
      message: [],
      Results: {
        series: [
          {
            seriesID: 'CUUR0000SA0',
            data: [
              { year: '2026', period: 'M06', value: '315.000' },
              { year: '2026', period: 'M05', value: '314.000' },
            ],
          },
        ],
      },
    };
    const service = new CpiService({ db, logger, fetcher: makeFetcher(response) });
    const points = await service.refreshMonthly('CUUR0000SA0');
    expect(points).toHaveLength(2);
    expect(points[0]?.index).toBe(314);
    expect(points[1]?.index).toBe(315);

    const series = await service.getSeries('CUUR0000SA0');
    expect(series).toHaveLength(2);
    expect(isoDateString(series[1]!.date)).toBe('2026-06-01');
  });

  it('filters series by date range', async () => {
    const response = {
      status: 'REQUEST_SUCCEEDED',
      Results: {
        series: [
          {
            seriesID: 'CUUR0000SA0',
            data: [
              { year: '2025', period: 'M12', value: '310.000' },
              { year: '2026', period: 'M01', value: '311.000' },
              { year: '2026', period: 'M02', value: '312.000' },
            ],
          },
        ],
      },
    };
    const service = new CpiService({ db, logger, fetcher: makeFetcher(response) });
    await service.refreshMonthly();
    const range = await service.getSeries('CUUR0000SA0', {
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    });
    expect(range).toHaveLength(1);
    expect(range[0]?.index).toBe(311);
  });
});
