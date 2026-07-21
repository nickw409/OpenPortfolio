import { AppError } from '@shared/errors';
import { ingestionError } from './ingestion-errors';

describe('ingestionError', () => {
  it('maps sell_exceeds_holdings to 409 and preserves context', () => {
    const err = ingestionError('ingestion.sell_exceeds_holdings', 'too much', { have: 1 });
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('ingestion.sell_exceeds_holdings');
    expect(err.status).toBe(409);
    expect(err.context).toEqual({ have: 1 });
  });

  it('maps future_date to 422 and account_not_found to 404', () => {
    expect(ingestionError('ingestion.future_date', 'x').status).toBe(422);
    expect(ingestionError('ingestion.account_not_found', 'x').status).toBe(404);
  });
});
