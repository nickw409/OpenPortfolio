import { getPreset } from './presets';

describe('broker presets', () => {
  it('returns null for unrecognized action text', () => {
    const preset = getPreset('fidelity');
    expect(preset.normalizeType('UNKNOWN CORPORATE ACTION')).toBeNull();
  });

  it('normalizes Schwab sell action', () => {
    const preset = getPreset('schwab');
    expect(preset.normalizeType('Sell')).toBe('sell');
  });

  it('normalizes Vanguard deposit action', () => {
    const preset = getPreset('vanguard');
    expect(preset.normalizeType('contribution')).toBe('deposit');
  });

  it('normalizes IBKR transfer out action', () => {
    const preset = getPreset('ibkr');
    expect(preset.normalizeType('delivered')).toBe('transfer_out');
  });
});
