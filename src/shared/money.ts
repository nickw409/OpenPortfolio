// Branded integer-cents primitive. Implementation does raw arithmetic
// on the underlying number internally; the no-money-arithmetic ESLint
// rule excludes this file. All other files MUST go through the helpers
// below — see docs/specs/2026-05-15-money-primitive-design.md.

export type Money = number & { readonly __brand: 'money' };

const brand = (cents: number): Money => cents as Money;

export const ZERO: Money = brand(0);

// ─── construction ───────────────────────────────────────────────────────

export function ofCents(cents: number): Money {
  if (!Number.isFinite(cents)) {
    throw new RangeError(`Money requires finite cents, got ${cents}`);
  }
  if (!Number.isInteger(cents)) {
    throw new RangeError(`Money requires integer cents, got ${cents}`);
  }
  return brand(cents);
}

export function ofDollars(dollars: number): Money {
  if (!Number.isFinite(dollars)) {
    throw new RangeError(`Money requires finite dollars, got ${dollars}`);
  }
  return brand(roundHalfToEven(dollars * 100));
}

export function isMoney(x: unknown): x is Money {
  return typeof x === 'number' && Number.isInteger(x) && Number.isFinite(x);
}

// ─── arithmetic ─────────────────────────────────────────────────────────

export function add(a: Money, b: Money): Money {
  return brand(a + b);
}

export function subtract(a: Money, b: Money): Money {
  return brand(a - b);
}

export function negate(a: Money): Money {
  return brand(-a);
}

export function abs(a: Money): Money {
  return brand(Math.abs(a));
}

export function sum(values: Iterable<Money>): Money {
  let total = 0;
  for (const v of values) total += v;
  return brand(total);
}

export function multiplyByRatio(m: Money, ratio: number): Money {
  if (!Number.isFinite(ratio)) {
    throw new RangeError(`ratio must be finite, got ${ratio}`);
  }
  return brand(roundHalfToEven(m * ratio));
}

export function divideByRatio(m: Money, divisor: number): Money {
  if (!Number.isFinite(divisor)) {
    throw new RangeError(`divisor must be finite, got ${divisor}`);
  }
  if (divisor === 0) {
    throw new RangeError('divide by zero');
  }
  return brand(roundHalfToEven(m / divisor));
}

export function divideByMoney(numerator: Money, denominator: Money): number {
  if (denominator === 0) {
    throw new RangeError('divide by zero');
  }
  return numerator / denominator;
}

// ─── comparison ─────────────────────────────────────────────────────────

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
export const eq = (a: Money, b: Money): boolean => a === b;
export const lt = (a: Money, b: Money): boolean => a < b;
export const lte = (a: Money, b: Money): boolean => a <= b;
export const gt = (a: Money, b: Money): boolean => a > b;
export const gte = (a: Money, b: Money): boolean => a >= b;

// ─── format / parse ─────────────────────────────────────────────────────

export interface FormatOptions {
  currencyCode?: string;
  locale?: string;
}

export function format(m: Money, opts: FormatOptions = {}): string {
  const { currencyCode = 'USD', locale = 'en-US' } = opts;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
  }).format(m / 100);
}

// Either a plain digit run, or 1–3 digits followed by ,DDD groups.
const PARSE_RE = /^-?\$?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?$/;

export function parse(text: string): Money {
  const trimmed = text.trim();
  if (!PARSE_RE.test(trimmed)) {
    throw new RangeError(`unable to parse Money from ${JSON.stringify(text)}`);
  }
  const cleaned = trimmed.replace(/[$,]/g, '');
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) {
    throw new RangeError(`unable to parse Money from ${JSON.stringify(text)}`);
  }
  return ofDollars(dollars);
}

// ─── rounding ───────────────────────────────────────────────────────────

// Half-to-even (banker's). JS Math.round is half-toward-+∞, which biases
// up across long histories. The .5 boundary is the only place the policy
// differs from Math.round; everything else falls through.
function roundHalfToEven(x: number): number {
  if (!Number.isFinite(x)) return x;
  const truncated = Math.trunc(x);
  const fraction = x - truncated;
  if (fraction === 0.5 || fraction === -0.5) {
    const floor = Math.floor(x);
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(x);
}
