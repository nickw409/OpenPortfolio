// Stable, namespaced codes for the financial calculation engine. Per spec
// F1 — argument-validation failures throw RangeError/TypeError; business-
// rule violations throw FinancialError with one of these codes. No silent
// failure; no null-for-couldn't-compute.

export type FinancialErrorCode =
  | 'domain.sell_exceeds_holdings'
  | 'domain.unknown_lot_reference'
  | 'domain.specific_selection_missing'
  | 'domain.specific_selection_quantity_mismatch'
  | 'domain.split_without_open_lots'
  | 'unsupported.corporate_action'
  | 'unsupported.mixed_currency'
  | 'unsupported.mixed_grouping'
  | 'price.stale'
  | 'cpi.out_of_range'
  | 'irr.bad_initial_state'
  | 'irr.no_solution'
  | 'irr.no_convergence'
  | 'allocation.missing_security'
  | 'allocation.missing_account';

export class FinancialError extends Error {
  override readonly name = 'FinancialError';
  readonly code: FinancialErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: FinancialErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
