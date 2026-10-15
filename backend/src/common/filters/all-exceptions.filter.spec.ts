import { NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { UnrecoverableError } from 'bullmq';
import { ChannelError, DomainValidationError, InsufficientInventoryError } from '../../database/errors';
import { isRetryable } from '../../jobs/job-handler';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const f = new AllExceptionsFilter();

  it('maps domain errors to the standard error envelope and HTTP status', () => {
    expect(f.toBody(new InsufficientInventoryError({ roomTypeId: 'x', requested: 1, failingNights: [] }))).toEqual({
      status: 409,
      body: { success: false, error: { code: 'ROOM_NOT_AVAILABLE', message: 'The selected room is not available.', details: expect.any(Object) } },
    });
    expect(f.toBody(new DomainValidationError('bad')).status).toBe(400);
    expect(f.toBody(new ThrottlerException()).body.error.code).toBe('RATE_LIMITED');
    expect(f.toBody(new NotFoundException()).body.error.code).toBe('NOT_FOUND');
  });

  it('never leaks internal error messages', () => {
    const r = f.toBody(new Error('E11000 connection string mongodb://user:pass@host'));
    expect(r).toEqual({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } });
  });
});

describe('job retry classification', () => {
  it('retries infrastructure errors, not business errors', () => {
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryable(new ChannelError('CHANNEL_UNAVAILABLE', '503', true))).toBe(true);
    expect(isRetryable(new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', 'no access', false))).toBe(false);
    expect(isRetryable(new DomainValidationError('bad payload'))).toBe(false);
    expect(isRetryable(new UnrecoverableError('stop'))).toBe(false);
  });
});
