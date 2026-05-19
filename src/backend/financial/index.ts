// Public surface of the financial calculation engine. See
// docs/specs/2026-05-18-financial-engine-slice-1.md.

export { FinancialError, type FinancialErrorCode } from './errors';
export { computeLots } from './lots';
export { computePosition, emptyPosition, type ComputePositionOptions } from './position';
export {
  computePortfolio,
  type ComputePortfolioOptions,
  type MethodResolver,
  type PortfolioResult,
} from './portfolio';
export { computeRealizedGainsLoss, type RealizedRange } from './realized';
export { computeIncomeStream, type IncomeRange } from './income';
export type {
  ClosedLot,
  ComputeLotsOptions,
  CostBasisMethod,
  IncomeSummary,
  Lot,
  LotResult,
  LotSelection,
  LotSelectionMap,
  PortfolioSnapshot,
  PositionSnapshot,
  PriceMap,
  RealizedSummary,
  Tx,
  TxType,
} from './types';
