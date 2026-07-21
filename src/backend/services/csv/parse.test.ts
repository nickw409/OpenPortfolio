import { parseCsv } from './parse';

describe('parseCsv', () => {
  it('parses headers and rows, trimming whitespace', () => {
    const { headers, rows } = parseCsv('Date,Symbol,Qty\n2020-01-02, AAPL ,10\n');
    expect(headers).toEqual(['Date', 'Symbol', 'Qty']);
    expect(rows[0]).toEqual({ Date: '2020-01-02', Symbol: 'AAPL', Qty: '10' });
  });

  it('handles quoted fields with embedded commas and newlines', () => {
    const text = 'Date,Note\n2020-01-02,"buy, then hold\nlong"\n';
    const { rows } = parseCsv(text);
    expect(rows[0]?.Note).toBe('buy, then hold\nlong');
  });

  it('throws ingestion.csv_parse_failed on malformed input', () => {
    expect(() => parseCsv('a,b\n"oops,1\n')).toThrow(/csv_parse_failed|parse/i);
  });
});
