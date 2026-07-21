import { describe, expect, it } from 'vitest';

import { getTileDefinition, listTileDefinitions, validateTileConfig } from './registry';

describe('tile registry', () => {
  it('registers the v1.0 tile types', () => {
    const types = listTileDefinitions().map((d) => d.type);
    expect(types).toEqual([
      'positions_table',
      'allocation_chart',
      'returns_timeline',
      'drawdown_summary',
      'dividend_calendar',
      'transaction_feed',
      'real_vs_nominal',
      'position_card',
    ]);
  });

  it('returns metadata for a registered tile', () => {
    const def = getTileDefinition('positions_table');
    expect(def).toBeDefined();
    expect(def?.name).toBe('Positions table');
    expect(def?.defaultSize).toEqual({ w: 12, h: 4 });
  });

  it('validates tile config with defaults', () => {
    const config = validateTileConfig('allocation_chart', {});
    expect(config).toEqual({ dimension: 'asset_class' });
  });

  it('throws for unknown tile type', () => {
    expect(() => validateTileConfig('unknown_tile', {})).toThrow('Unknown tile type: unknown_tile');
  });
});
