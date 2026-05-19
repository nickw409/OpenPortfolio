import { FinancialError } from './errors';
import { cpiAt, computeRealReturn } from './cpi';
import { buildCpiSeries, dateD } from './test-helpers';

describe('cpiAt — exact-date lookup', () => {
  it('returns the index on an exact release date', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-02-01', 303.0],
    ]);
    expect(cpiAt(cpi, dateD('2026-01-01'))).toBe(300.0);
    expect(cpiAt(cpi, dateD('2026-02-01'))).toBe(303.0);
  });
});

describe('cpiAt — linear interpolation', () => {
  it('returns the midpoint exactly halfway between releases', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-02-01', 303.0],
    ]);
    // 2026-01-16 is 15/31 of the way from Jan-1 to Feb-1.
    const expected = 300.0 + (303.0 - 300.0) * (15 / 31);
    expect(cpiAt(cpi, dateD('2026-01-16'))).toBeCloseTo(expected, 10);
  });
});

describe('cpiAt — out of range', () => {
  it('throws cpi.out_of_range below first release', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-02-01', 303.0],
    ]);
    try {
      cpiAt(cpi, dateD('2025-12-31'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('cpi.out_of_range');
    }
  });

  it('throws cpi.out_of_range above last release', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-02-01', 303.0],
    ]);
    try {
      cpiAt(cpi, dateD('2026-02-02'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('cpi.out_of_range');
    }
  });

  it('throws on empty cpi series', () => {
    try {
      cpiAt(buildCpiSeries([]), dateD('2026-01-01'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('cpi.out_of_range');
    }
  });
});

describe('computeRealReturn — period-boundary deflation', () => {
  it('zero inflation ⇒ real == nominal', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2027-01-01', 300.0],
    ]);
    const result = computeRealReturn(
      10.0, // 10% nominal
      { from: dateD('2026-01-01'), to: dateD('2027-01-01') },
      cpi,
    );
    expect(result.real_pct).toBeCloseTo(10.0, 8);
    expect(result.cpi_change_pct).toBeCloseTo(0, 8);
  });

  it('positive inflation reduces real return: (1+nom)/(1+cpi) - 1', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2027-01-01', 309.0], // +3% CPI
    ]);
    const result = computeRealReturn(
      10.0,
      { from: dateD('2026-01-01'), to: dateD('2027-01-01') },
      cpi,
    );
    // real = (1.10 / 1.03) - 1 = 0.067961... = 6.7961...%
    expect(result.real_pct).toBeCloseTo(6.7961165, 5);
    expect(result.cpi_change_pct).toBeCloseTo(3.0, 8);
  });

  it('range validation: throws RangeError when to < from', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2027-01-01', 303.0],
    ]);
    expect(() =>
      computeRealReturn(5, { from: dateD('2027-01-01'), to: dateD('2026-01-01') }, cpi),
    ).toThrow(RangeError);
  });

  it('zero-length period (from === to): real == nominal exactly', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2027-01-01', 310.0],
    ]);
    const result = computeRealReturn(
      5.0,
      { from: dateD('2026-06-01'), to: dateD('2026-06-01') },
      cpi,
    );
    expect(result.real_pct).toBeCloseTo(5.0, 10);
    expect(result.cpi_change_pct).toBeCloseTo(0, 10);
  });

  it('throws cpi.out_of_range when CPI index at range start is zero', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 0],
      ['2027-01-01', 310.0],
    ]);
    try {
      computeRealReturn(5, { from: dateD('2026-01-01'), to: dateD('2027-01-01') }, cpi);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('cpi.out_of_range');
    }
  });
});
