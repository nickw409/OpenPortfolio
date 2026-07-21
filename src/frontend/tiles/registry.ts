import React, { type ComponentType, type CSSProperties } from 'react';
import { z } from 'zod';

import {
  AllocationChartConfigSchema,
  DividendCalendarConfigSchema,
  DrawdownSummaryConfigSchema,
  PositionCardConfigSchema,
  PositionsTableConfigSchema,
  RealVsNominalConfigSchema,
  ReturnsTimelineConfigSchema,
  TransactionFeedConfigSchema,
} from './schemas';

export interface TileSize {
  w: number;
  h: number;
}

export interface TileComponentProps<TConfig = unknown> {
  tileId: number;
  layoutId: number;
  config: TConfig;
  onConfigChange: (config: TConfig) => void;
  style?: CSSProperties;
}

export interface TileDefinition<TConfig = unknown> {
  type: string;
  name: string;
  description: string;
  defaultSize: TileSize;
  allowedSizes: TileSize[];
  configSchema: z.ZodSchema<TConfig>;
  component: ComponentType<TileComponentProps<TConfig>>;
}

const registry = new Map<string, TileDefinition<unknown>>();

export function registerTile<TConfig>(definition: TileDefinition<TConfig>): void {
  registry.set(definition.type, definition as TileDefinition<unknown>);
}

export function getTileDefinition(type: string): TileDefinition<unknown> | undefined {
  return registry.get(type);
}

export function listTileDefinitions(): TileDefinition<unknown>[] {
  return Array.from(registry.values());
}

export function validateTileConfig(type: string, raw: unknown): unknown {
  const def = getTileDefinition(type);
  if (!def) throw new Error(`Unknown tile type: ${type}`);
  return def.configSchema.parse(raw);
}

// Placeholder tile components render a compact skeleton showing the tile name.
// They are replaced by real implementations as tiles are built out.

function PlaceholderTile({ name }: { name: string }): JSX.Element {
  return React.createElement('div', {
    style: {
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '0.875rem',
      color: 'var(--op-muted, #666)',
    },
  }, name);
}

function createPlaceholderComponent(
  name: string,
): ComponentType<TileComponentProps<unknown>> {
  return function PlaceholderComponent(): JSX.Element {
    return React.createElement(PlaceholderTile, { name });
  };
}

registerTile({
  type: 'positions_table',
  name: 'Positions table',
  description: 'Account-filterable table of current holdings.',
  defaultSize: { w: 12, h: 4 },
  allowedSizes: [{ w: 12, h: 4 }],
  configSchema: PositionsTableConfigSchema,
  component: createPlaceholderComponent('Positions table'),
});

registerTile({
  type: 'allocation_chart',
  name: 'Allocation chart',
  description: 'Donut/bar chart by asset class, account, or security.',
  defaultSize: { w: 6, h: 4 },
  allowedSizes: [
    { w: 6, h: 4 },
    { w: 4, h: 4 },
  ],
  configSchema: AllocationChartConfigSchema,
  component: createPlaceholderComponent('Allocation chart'),
});

registerTile({
  type: 'returns_timeline',
  name: 'Returns timeline',
  description: 'Portfolio value over time with optional real-return overlay.',
  defaultSize: { w: 12, h: 4 },
  allowedSizes: [{ w: 12, h: 4 }],
  configSchema: ReturnsTimelineConfigSchema,
  component: createPlaceholderComponent('Returns timeline'),
});

registerTile({
  type: 'drawdown_summary',
  name: 'Drawdown summary',
  description: 'Max and current drawdown with peak/trough dates.',
  defaultSize: { w: 6, h: 4 },
  allowedSizes: [{ w: 6, h: 4 }],
  configSchema: DrawdownSummaryConfigSchema,
  component: createPlaceholderComponent('Drawdown summary'),
});

registerTile({
  type: 'dividend_calendar',
  name: 'Dividend calendar',
  description: 'Monthly dividend view over a rolling window.',
  defaultSize: { w: 6, h: 4 },
  allowedSizes: [{ w: 6, h: 4 }],
  configSchema: DividendCalendarConfigSchema,
  component: createPlaceholderComponent('Dividend calendar'),
});

registerTile({
  type: 'transaction_feed',
  name: 'Transaction feed',
  description: 'Recent transactions with soft-delete actions.',
  defaultSize: { w: 6, h: 4 },
  allowedSizes: [{ w: 6, h: 4 }],
  configSchema: TransactionFeedConfigSchema,
  component: createPlaceholderComponent('Transaction feed'),
});

registerTile({
  type: 'real_vs_nominal',
  name: 'Real vs nominal',
  description: 'Nominal vs real return comparison card.',
  defaultSize: { w: 4, h: 4 },
  allowedSizes: [{ w: 4, h: 4 }],
  configSchema: RealVsNominalConfigSchema,
  component: createPlaceholderComponent('Real vs nominal'),
});

registerTile({
  type: 'position_card',
  name: 'Position card',
  description: 'Focused summary for a single security.',
  defaultSize: { w: 4, h: 4 },
  allowedSizes: [{ w: 4, h: 4 }],
  configSchema: PositionCardConfigSchema,
  component: createPlaceholderComponent('Position card'),
});
