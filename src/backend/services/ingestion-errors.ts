import { AppError, type ErrorCode } from '@shared/errors';

type IngestionCode = Extract<ErrorCode, `ingestion.${string}`>;

export const INGESTION_STATUS: Record<IngestionCode, number> = {
  'ingestion.sell_exceeds_holdings': 409,
  'ingestion.future_date': 422,
  'ingestion.invalid_quantity': 422,
  'ingestion.invalid_price': 422,
  'ingestion.account_not_found': 404,
  'ingestion.security_not_found': 404,
  'ingestion.transaction_not_found': 404,
  'ingestion.csv_parse_failed': 400,
  'ingestion.csv_mapping_incomplete': 400,
  'ingestion.commit_has_errors': 422,
};

export function ingestionError(
  code: IngestionCode,
  message: string,
  context?: Record<string, unknown>,
): AppError {
  return new AppError({ code, message, status: INGESTION_STATUS[code], context });
}
