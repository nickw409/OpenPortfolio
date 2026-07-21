import { z } from 'zod';

export const TAX_TREATMENTS = ['taxable', 'tax_deferred', 'tax_free'] as const;
export const COST_BASIS_METHODS = ['fifo', 'lifo', 'specific'] as const;

export const TaxTreatmentSchema = z.enum(TAX_TREATMENTS);
export const CostBasisMethodSchema = z.enum(COST_BASIS_METHODS);

export type TaxTreatment = z.infer<typeof TaxTreatmentSchema>;
export type CostBasisMethod = z.infer<typeof CostBasisMethodSchema>;

export const AccountSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  broker: z.string().nullable(),
  taxTreatment: TaxTreatmentSchema,
  costBasisMethod: CostBasisMethodSchema,
  currencyCode: z.string().length(3),
  // ISO 8601 string — wire shape is JSON; route handlers convert Date → toISOString().
  createdAt: z.string().datetime(),
});

export type Account = z.infer<typeof AccountSchema>;

export const AccountsResponseSchema = z.object({
  accounts: z.array(AccountSchema),
});

export type AccountsResponse = z.infer<typeof AccountsResponseSchema>;

export const CreateAccountSchema = z.object({
  name: z.string().trim().min(1),
  broker: z.string().trim().min(1).optional(),
  tax_treatment: z.enum(TAX_TREATMENTS),
  cost_basis_method: z.enum(COST_BASIS_METHODS).default('fifo'),
  currency_code: z.string().trim().length(3).default('USD'),
});
export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;

export const RenameAccountSchema = z.object({
  name: z.string().trim().min(1).optional(),
  broker: z.string().trim().min(1).nullable().optional(),
  tax_treatment: z.enum(TAX_TREATMENTS).optional(),
  cost_basis_method: z.enum(COST_BASIS_METHODS).optional(),
});
export type RenameAccountInput = z.infer<typeof RenameAccountSchema>;
