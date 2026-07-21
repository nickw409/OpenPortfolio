import { z } from 'zod';

import { MoneySchema, NonNegativeMoneySchema } from './money';

// Mirrors the financial engine's TxType union (src/backend/financial/types.ts)
// and the transactions.transaction_type column semantics.
export const TX_TYPES = [
  'buy',
  'sell',
  'dividend',
  'interest',
  'fee',
  'split',
  'transfer_in',
  'transfer_out',
  'deposit',
  'withdrawal',
] as const;
export type TxTypeName = (typeof TX_TYPES)[number];

// Types that move shares → need engine over-sell validation.
const LOT_AFFECTING = new Set<TxTypeName>(['buy', 'sell', 'split', 'transfer_in', 'transfer_out']);
// Types that reference a security by symbol (dividend does, deposit does not).
const SECURITY_BEARING = new Set<TxTypeName>([
  'buy',
  'sell',
  'split',
  'transfer_in',
  'transfer_out',
  'dividend',
]);

export const isLotAffecting = (t: TxTypeName): boolean => LOT_AFFECTING.has(t);
export const isSecurityBearing = (t: TxTypeName): boolean => SECURITY_BEARING.has(t);

// Base field shapes (no cross-field rules — those live in refineTransaction so
// create and edit share one implementation).
const TransactionFields = z.object({
  account_id: z.number().int().positive(),
  symbol: z.string().trim().min(1).optional(),
  transaction_type: z.enum(TX_TYPES),
  transaction_date: z.coerce.date(),
  quantity: z.number().finite().nonnegative().default(0),
  price_cents: NonNegativeMoneySchema.optional(),
  amount_cents: MoneySchema,
  fee_cents: NonNegativeMoneySchema.optional(),
  currency_code: z.string().trim().length(3).default('USD'),
  notes: z.string().optional(),
});

type TransactionShape = z.infer<typeof TransactionFields>;

export function refineTransaction(v: TransactionShape, ctx: z.RefinementCtx): void {
  if (v.transaction_date.getTime() > Date.now()) {
    ctx.addIssue({
      code: 'custom',
      path: ['transaction_date'],
      message: 'transaction_date cannot be in the future',
    });
  }
  if (isLotAffecting(v.transaction_type) && !(v.quantity > 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['quantity'],
      message: `quantity must be positive for ${v.transaction_type}`,
    });
  }
  if (
    (v.transaction_type === 'buy' || v.transaction_type === 'sell') &&
    !(typeof v.price_cents === 'number' && v.price_cents > 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['price_cents'],
      message: 'price_cents must be positive for buy/sell',
    });
  }
  if (isSecurityBearing(v.transaction_type) && !v.symbol) {
    ctx.addIssue({
      code: 'custom',
      path: ['symbol'],
      message: `symbol is required for ${v.transaction_type}`,
    });
  }
}

export const CreateTransactionSchema = TransactionFields.superRefine(refineTransaction);
export type CreateTransactionInput = z.infer<typeof CreateTransactionSchema>;

// Patch shape for edits — every field optional; the service merges this over
// the existing row and re-parses through CreateTransactionSchema.
export const EditTransactionSchema = TransactionFields.partial();
export type EditTransactionInput = z.infer<typeof EditTransactionSchema>;
