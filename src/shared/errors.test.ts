import { AppError } from './errors';

describe('AppError', () => {
  it('preserves code, status, message, and context', () => {
    const err = new AppError({
      code: 'validation.invalid_input',
      message: 'bad request',
      status: 400,
      context: { field: 'date' },
    });
    expect(err.code).toBe('validation.invalid_input');
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad request');
    expect(err.context).toEqual({ field: 'date' });
    expect(err.name).toBe('AppError');
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves cause when provided', () => {
    const inner = new Error('root cause');
    const err = new AppError({
      code: 'internal.unknown',
      message: 'wrapper',
      status: 500,
      cause: inner,
    });
    expect(err.cause).toBe(inner);
  });

  it('omits the context key from the envelope when undefined', () => {
    const err = new AppError({
      code: 'not_found.resource',
      message: 'missing',
      status: 404,
    });
    expect(err.toEnvelope()).toEqual({
      code: 'not_found.resource',
      message: 'missing',
    });
    expect('context' in err.toEnvelope()).toBe(false);
  });

  it('includes context in the envelope when provided', () => {
    const err = new AppError({
      code: 'not_found.resource',
      message: 'missing',
      status: 404,
      context: { resource: 'account', id: 7 },
    });
    expect(err.toEnvelope()).toEqual({
      code: 'not_found.resource',
      message: 'missing',
      context: { resource: 'account', id: 7 },
    });
  });
});
