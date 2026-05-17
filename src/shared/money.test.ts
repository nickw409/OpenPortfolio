import fc from 'fast-check';

import {
  ZERO,
  abs,
  add,
  compare,
  divideByMoney,
  divideByRatio,
  eq,
  format,
  gt,
  gte,
  isMoney,
  lt,
  lte,
  multiplyByRatio,
  negate,
  ofCents,
  ofDollars,
  parse,
  subtract,
  sum,
  type Money,
} from './money';

// Bound generators so sums and products stay inside Number.MAX_SAFE_INTEGER.
// 10^9 cents = $10M; 3 × 10^9 < 2^53; (10^9 × 1000) < 2^53.
const cents = (): fc.Arbitrary<Money> =>
  fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }).map(ofCents);

const ratio = (): fc.Arbitrary<number> =>
  fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });

describe('ofCents', () => {
  it('accepts integer cents', () => {
    expect(ofCents(0)).toBe(0);
    expect(ofCents(150)).toBe(150);
    expect(ofCents(-50)).toBe(-50);
  });

  it.each([NaN, Infinity, -Infinity, 1.5, 0.1])('rejects %s', (bad) => {
    expect(() => ofCents(bad)).toThrow(RangeError);
  });
});

describe('ofDollars', () => {
  it('converts whole dollars to cents', () => {
    expect(ofDollars(0)).toBe(0);
    expect(ofDollars(1)).toBe(100);
    expect(ofDollars(-2)).toBe(-200);
  });

  it('converts fractional dollars to cents', () => {
    expect(ofDollars(1.5)).toBe(150);
    expect(ofDollars(0.01)).toBe(1);
    expect(ofDollars(-0.99)).toBe(-99);
  });

  it.each([NaN, Infinity, -Infinity])('rejects %s', (bad) => {
    expect(() => ofDollars(bad)).toThrow(RangeError);
  });
});

describe('isMoney', () => {
  it('identifies Money values', () => {
    expect(isMoney(ofCents(100))).toBe(true);
    expect(isMoney(0)).toBe(true); // brand check is structural
  });

  it('rejects non-Money', () => {
    expect(isMoney(1.5)).toBe(false);
    expect(isMoney(NaN)).toBe(false);
    expect(isMoney(Infinity)).toBe(false);
    expect(isMoney('100')).toBe(false);
    expect(isMoney(null)).toBe(false);
  });
});

describe('arithmetic — examples', () => {
  it('add', () => {
    expect(add(ofCents(100), ofCents(50))).toBe(150);
    expect(add(ofCents(100), ofCents(-50))).toBe(50);
  });

  it('subtract', () => {
    expect(subtract(ofCents(100), ofCents(40))).toBe(60);
  });

  it('negate / abs', () => {
    expect(negate(ofCents(100))).toBe(-100);
    expect(abs(ofCents(-100))).toBe(100);
    expect(abs(ofCents(100))).toBe(100);
  });

  it('sum', () => {
    expect(sum([ofCents(100), ofCents(200), ofCents(300)])).toBe(600);
    expect(sum([])).toBe(ZERO);
  });

  it('multiplyByRatio', () => {
    expect(multiplyByRatio(ofCents(100), 0.5)).toBe(50);
    expect(multiplyByRatio(ofCents(100), 2)).toBe(200);
  });

  it('divideByRatio', () => {
    expect(divideByRatio(ofCents(100), 4)).toBe(25);
  });

  it('divideByMoney returns a plain number ratio', () => {
    expect(divideByMoney(ofCents(150), ofCents(100))).toBe(1.5);
  });

  it.each([
    ['multiplyByRatio', () => multiplyByRatio(ofCents(100), NaN)],
    ['multiplyByRatio infinity', () => multiplyByRatio(ofCents(100), Infinity)],
    ['divideByRatio NaN', () => divideByRatio(ofCents(100), NaN)],
    ['divideByRatio zero', () => divideByRatio(ofCents(100), 0)],
    ['divideByMoney zero', () => divideByMoney(ofCents(100), ofCents(0))],
  ])('%s rejects bad input', (_label, fn) => {
    expect(fn).toThrow(RangeError);
  });
});

describe('half-to-even rounding', () => {
  it.each([
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [-0.5, 0],
    [-1.5, -2],
    [-2.5, -2],
    [100.5, 100],
    [101.5, 102],
  ])('multiplyByRatio rounds %f → %i (banker)', (cents_in, expected) => {
    // multiplyByRatio with ratio=1 is identity; we exercise rounding by
    // constructing an exact .5 cents value via ratio multiplication.
    expect(multiplyByRatio(ofCents(2), cents_in / 2)).toBe(expected);
  });
});

describe('comparison', () => {
  it('compare returns -1/0/1', () => {
    expect(compare(ofCents(50), ofCents(100))).toBe(-1);
    expect(compare(ofCents(100), ofCents(100))).toBe(0);
    expect(compare(ofCents(100), ofCents(50))).toBe(1);
  });

  it('eq / lt / lte / gt / gte', () => {
    const a = ofCents(100);
    const b = ofCents(200);
    expect(eq(a, a)).toBe(true);
    expect(eq(a, b)).toBe(false);
    expect(lt(a, b)).toBe(true);
    expect(lte(a, a)).toBe(true);
    expect(gt(b, a)).toBe(true);
    expect(gte(a, a)).toBe(true);
  });
});

describe('format / parse', () => {
  it('format defaults to USD en-US', () => {
    expect(format(ofCents(123456))).toBe('$1,234.56');
    expect(format(ofCents(-50))).toBe('-$0.50');
    expect(format(ZERO)).toBe('$0.00');
  });

  it('format honors options', () => {
    expect(format(ofCents(100), { currencyCode: 'EUR', locale: 'de-DE' })).toContain('€');
  });

  it('parse accepts canonical forms', () => {
    expect(parse('1234.56')).toBe(123456);
    expect(parse('1,234.56')).toBe(123456);
    expect(parse('$1,234.56')).toBe(123456);
    expect(parse('-1,234.56')).toBe(-123456);
    expect(parse('  100  ')).toBe(10000);
  });

  it.each(['', 'abc', '1.2.3', '$$100', '1,2,3.45'])('parse rejects %p', (bad) => {
    expect(() => parse(bad)).toThrow(RangeError);
  });
});

describe('algebraic properties', () => {
  it('add is commutative', () => {
    fc.assert(fc.property(cents(), cents(), (a, b) => add(a, b) === add(b, a)));
  });

  it('add is associative', () => {
    fc.assert(
      fc.property(cents(), cents(), cents(), (a, b, c) => add(add(a, b), c) === add(a, add(b, c))),
    );
  });

  it('ZERO is the additive identity', () => {
    fc.assert(fc.property(cents(), (a) => add(a, ZERO) === a && add(ZERO, a) === a));
  });

  it('subtract is the inverse of add', () => {
    fc.assert(fc.property(cents(), (a) => subtract(a, a) === ZERO));
  });

  it('negate is involutive', () => {
    fc.assert(fc.property(cents(), (a) => negate(negate(a)) === a));
  });

  it('sum equals left-fold of add', () => {
    fc.assert(
      fc.property(fc.array(cents(), { maxLength: 50 }), (arr) => {
        const folded = arr.reduce<Money>((acc, x) => add(acc, x), ZERO);
        return sum(arr) === folded;
      }),
    );
  });

  it('multiplyByRatio(_, 1) is identity', () => {
    fc.assert(fc.property(cents(), (a) => multiplyByRatio(a, 1) === a));
  });

  it('multiplyByRatio(_, 0) is zero', () => {
    fc.assert(fc.property(cents(), (a) => multiplyByRatio(a, 0) === ZERO));
  });

  it('compare is antisymmetric', () => {
    fc.assert(fc.property(cents(), cents(), (a, b) => compare(a, b) === -compare(b, a)));
  });

  it('abs is non-negative and idempotent', () => {
    fc.assert(fc.property(cents(), (a) => abs(a) >= 0 && abs(abs(a)) === abs(a)));
  });

  it('multiplyByRatio output is always integer cents', () => {
    fc.assert(
      fc.property(cents(), ratio(), (a, r) => Number.isInteger(multiplyByRatio(a, r))),
    );
  });

  it('format -> parse round-trips for representable cents', () => {
    fc.assert(
      fc.property(cents(), (a) => parse(format(a).replace(/[$,\s]/g, '')) === a),
    );
  });
});
