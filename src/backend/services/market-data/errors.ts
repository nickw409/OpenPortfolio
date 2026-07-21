import { AppError } from '@shared/errors';
import { FinancialError } from '@backend/financial/errors';

// Stable, namespaced codes for the price-data subsystem. These are used by
// the provider layer, the service layer, and route error handling.

export type MarketDataErrorCode =
  | 'price.fetch_failed'
  | 'price.unexpected_response'
  | 'price.invalid_symbol'
  | 'price.rate_limited'
  | 'price.no_provider'
  | 'price.no_price'
  | 'price.stale'
  | 'cpi.fetch_failed'
  | 'cpi.unexpected_response';

export class MarketDataError extends Error {
  override readonly name = 'MarketDataError';
  readonly code: MarketDataErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  readonly status: number;

  constructor(
    code: MarketDataErrorCode,
    message: string,
    status: number,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.context = Object.freeze({ ...context });
  }

  toAppError(): AppError {
    return new AppError({
      code: mapToAppCode(this.code),
      message: this.message,
      status: this.status,
      context: this.context,
      cause: this,
    });
  }
}

function mapToAppCode(
  code: MarketDataErrorCode,
):
  | 'validation.invalid_input'
  | 'not_found.resource'
  | 'service.migrating'
  | 'service.shutting_down'
  | 'internal.unknown' {
  switch (code) {
    case 'price.invalid_symbol':
    case 'price.no_provider':
      return 'validation.invalid_input';
    case 'price.no_price':
      return 'not_found.resource';
    case 'price.fetch_failed':
    case 'price.unexpected_response':
    case 'price.rate_limited':
    case 'price.stale':
    case 'cpi.fetch_failed':
    case 'cpi.unexpected_response':
      return 'internal.unknown';
  }
}

export function isMarketDataError(err: unknown): err is MarketDataError {
  return err instanceof MarketDataError;
}

export function isFinancialError(err: unknown): err is FinancialError {
  return err instanceof FinancialError;
}
