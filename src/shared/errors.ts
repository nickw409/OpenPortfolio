// Backend error model. See docs/specs/2026-05-18-backend-api-design.md §T2.
//
// Codes are namespaced strings (group.specific). The frontend switches on
// `code`; `message` is human-readable; `context` carries structured detail.
// Grow this list as new failure modes are introduced — dead codes accrete,
// so add only when something actually throws them.

export const ERROR_CODES = [
  'validation.invalid_input',
  'validation.invalid_money',
  'not_found.resource',
  'service.migrating',
  'service.shutting_down',
  'internal.unknown',
  'ingestion.sell_exceeds_holdings',
  'ingestion.future_date',
  'ingestion.invalid_quantity',
  'ingestion.invalid_price',
  'ingestion.account_not_found',
  'ingestion.security_not_found',
  'ingestion.transaction_not_found',
  'ingestion.csv_parse_failed',
  'ingestion.csv_mapping_incomplete',
  'ingestion.commit_has_errors',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  context?: Record<string, unknown>;
}

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  status: number;
  context?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly context: Record<string, unknown> | undefined;

  constructor(opts: AppErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = opts.code;
    this.status = opts.status;
    this.context = opts.context;
    this.name = 'AppError';
  }

  toEnvelope(): ErrorEnvelope {
    return this.context === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, context: this.context };
  }
}
