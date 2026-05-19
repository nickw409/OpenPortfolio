import { z } from 'zod';

export const TaxTreatmentSchema = z.enum(['taxable', 'tax_deferred', 'tax_free']);
export const CostBasisMethodSchema = z.enum(['fifo', 'lifo', 'specific']);

export const AccountSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  broker: z.string().nullable(),
  taxTreatment: TaxTreatmentSchema,
  costBasisMethod: CostBasisMethodSchema,
  currencyCode: z.string().length(3),
  createdAt: z.string().datetime(),
});

export type Account = z.infer<typeof AccountSchema>;

export const AccountsResponseSchema = z.object({
  accounts: z.array(AccountSchema),
});

export type AccountsResponse = z.infer<typeof AccountsResponseSchema>;
