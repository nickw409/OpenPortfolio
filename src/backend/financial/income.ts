// Income stream summarizer. Aggregates dividends, interest, and fees over
// an optional inclusive date range. Yield (e.g. TTM-dividends ÷ current
// portfolio market value) is left to callers that know the current value;
// the engine only emits the dividend totals.

import { ZERO, add, subtract, type Money } from '@shared/money';

import type { IncomeSummary, Tx } from './types';

export interface IncomeRange {
  from?: Date;
  to?: Date;
}

export function computeIncomeStream(txns: readonly Tx[], range: IncomeRange = {}): IncomeSummary {
  const fromMs = range.from?.getTime();
  const toMs = range.to?.getTime();

  let dividends: Money = ZERO;
  let interest: Money = ZERO;
  let fees: Money = ZERO;

  for (const t of txns) {
    const ms = t.transaction_date.getTime();
    if (fromMs !== undefined && ms < fromMs) continue;
    if (toMs !== undefined && ms > toMs) continue;

    switch (t.transaction_type) {
      case 'dividend':
        dividends = add(dividends, t.amount_cents);
        break;
      case 'interest':
        interest = add(interest, t.amount_cents);
        break;
      case 'fee':
        fees = add(fees, t.amount_cents);
        break;
      default:
        break;
    }
  }

  return {
    dividends_cents: dividends,
    interest_cents: interest,
    fees_cents: fees,
    net_cents: subtract(add(dividends, interest), fees),
  };
}
