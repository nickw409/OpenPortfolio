import { applyMapping, canonicalToCreateInput } from './mapping';
import { BROKER_PRESETS, getPreset } from './presets';

const rows = [{ D: '2020-01-02', T: 'buy', S: 'AAPL', Q: '10', P: '150.00', A: '1500.00' }];
const mapping = {
  transaction_date: 'D',
  transaction_type: 'T',
  symbol: 'S',
  quantity: 'Q',
  price: 'P',
  amount: 'A',
};

describe('applyMapping', () => {
  it('projects raw rows onto canonical fields', () => {
    const [row] = applyMapping(rows, mapping);
    expect(row!.symbol).toBe('AAPL');
    expect(row!.price).toBe('150.00');
    expect(row!.sourceIndex).toBe(0);
  });

  it('throws when a required header is missing', () => {
    expect(() =>
      applyMapping(rows, { transaction_date: 'D', transaction_type: 'MISSING' }),
    ).toThrow(/mapping_incomplete|missing/i);
  });
});

describe('canonicalToCreateInput', () => {
  it('converts dollar strings to integer cents', () => {
    const [row] = applyMapping(rows, mapping);
    const input = canonicalToCreateInput(row!, 1);
    expect(input.amount_cents).toBe(150000);
    expect(input.price_cents).toBe(15000);
    expect(input.quantity).toBe(10);
    expect(input.account_id).toBe(1);
  });
});

describe('broker presets', () => {
  it('exposes the four v1.0 presets', () => {
    expect(Object.keys(BROKER_PRESETS).sort()).toEqual(['fidelity', 'ibkr', 'schwab', 'vanguard']);
  });

  it('fidelity preset maps a sample row and normalizes the type', () => {
    const preset = getPreset('fidelity');
    const sampleRows = [
      {
        'Run Date': '01/02/2020',
        Action: 'YOU BOUGHT',
        Symbol: 'AAPL',
        Quantity: '10',
        'Price ($)': '150.00',
        'Amount ($)': '-1500.00',
      },
    ];
    const [canonical] = applyMapping(sampleRows, preset.mapping);
    const input = canonicalToCreateInput(canonical!, 1, preset.normalizeType);
    expect(input.transaction_type).toBe('buy');
    expect(input.symbol).toBe('AAPL');
  });
});
