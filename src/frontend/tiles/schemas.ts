import { z } from 'zod';

// Shared tile config schemas. Each tile type exports a Zod schema so the
// registry can validate config at the boundary. Unknown keys are stripped
// by .passthrough() / .strict() choices per schema.

export const PositionsTableConfigSchema = z.object({
  accounts: z.array(z.number().int().positive()).default([]),
});

export const AllocationChartConfigSchema = z.object({
  dimension: z.enum(['asset_class', 'account', 'security']).default('asset_class'),
});

export const ReturnsTimelineConfigSchema = z.object({
  rangeYears: z.number().int().min(1).max(50).default(5),
  real: z.boolean().default(false),
});

export const DrawdownSummaryConfigSchema = z.object({
  rangeYears: z.number().int().min(1).max(50).default(5),
});

export const DividendCalendarConfigSchema = z.object({
  months: z.number().int().min(3).max(24).default(12),
});

export const TransactionFeedConfigSchema = z.object({
  limit: z.number().int().min(1).max(100).default(10),
});

export const RealVsNominalConfigSchema = z.object({
  rangeYears: z.number().int().min(1).max(50).default(10),
});

export const PositionCardConfigSchema = z.object({
  security_id: z.number().int().positive().nullable().default(null),
});
