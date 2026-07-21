import { parse as parseSync } from 'csv-parse/sync';

import { ingestionError } from '../ingestion-errors';

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  let records: Record<string, string>[];
  try {
    records = parseSync(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    }) as Record<string, string>[];
  } catch (e) {
    throw ingestionError('ingestion.csv_parse_failed', 'failed to parse CSV', { cause: (e as Error).message });
  }
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  return { headers, rows: records };
}
