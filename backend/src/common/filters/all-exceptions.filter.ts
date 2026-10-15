import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { DomainError } from '../../database/errors';

export interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

const DOMAIN_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_INVALID: 401,
  TOKEN_REUSED: 401,
  SESSION_REVOKED: 401,
  ACCOUNT_INACTIVE: 401,
  INVALID_SIGNATURE: 401,
  ROOM_NOT_AVAILABLE: 409,
  INVENTORY_NOT_INITIALIZED: 409,
  RESTRICTION_VIOLATION: 409,
  INVALID_STATE_TRANSITION: 409,
  ROOM_ASSIGNMENT_CONFLICT: 409,
  ROOM_NOT_READY: 409,
  DUPLICATE: 409,
  EMAIL_TAKEN: 409,
  SLUG_TAKEN: 409,
  CHANNEL_MAPPING_MISSING: 422,
  CHANNEL_NOT_CONNECTED: 422,
  CHANNEL_INTEGRATION_NOT_AVAILABLE: 422,
  CHANNEL_NOT_SUPPORTED: 404,
  PROMO_INVALID: 422,
  PAYMENT_SIGNATURE_INVALID: 400,
  PAYMENT_NOT_CONFIGURED: 422,
  PAYMENT_PROVIDER_ERROR: 502,
  REFUND_EXCEEDS_BALANCE: 422,
  INVENTORY_INVARIANT: 500,
  // Public API (/v1)
  API_KEY_MISSING: 401,
  API_KEY_INVALID: 401,
  API_KEY_REVOKED: 401,
  API_KEY_EXPIRED: 401,
  API_SCOPE_MISSING: 403,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
};

const HTTP_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
};

/**
 * Every error leaves the API as { success: false, error: { code, message } }.
 * Unknown errors become INTERNAL_ERROR with a generic message: stack traces
 * and driver messages (which can contain data) never reach clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toBody(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    res.status(status).json(body);
  }

  toBody(e: unknown): { status: number; body: ErrorBody } {
    const out = (status: number, code: string, message: string, details?: unknown) => ({
      status,
      body: { success: false as const, error: { code, message, ...(details !== undefined ? { details } : {}) } },
    });

    if (e instanceof DomainError) {
      const status = DOMAIN_STATUS[e.code] ?? (e.name === 'ConflictError' ? 409 : 400);
      return out(status, e.code, e.message, status < 500 ? e.details : undefined);
    }
    if (e instanceof ThrottlerException) return out(429, 'RATE_LIMITED', 'Too many requests. Please slow down.');
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const r = e.getResponse() as string | { message?: string | string[]; code?: string; details?: unknown };
      const message = typeof r === 'string' ? r : Array.isArray(r.message) ? r.message.join('; ') : r.message ?? e.message;
      const code = typeof r === 'object' && r.code ? r.code : HTTP_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
      // Plain 500s may carry internals; deliberate 5xx (e.g. 503 from /health) keep their message.
      return out(status, code, status === 500 ? 'Internal server error' : message, typeof r === 'object' && status !== 500 ? r.details : undefined);
    }
    // PostgreSQL errors (SQLSTATE). Driver messages can contain data, so only generic text leaves the API.
    switch ((e as { code?: string })?.code) {
      case '23505':
        return out(409, 'DUPLICATE', 'A record with the same unique value already exists');
      case '23503':
        return out(409, 'CONFLICT', 'The record refers to something that does not exist, or is still in use');
      case '23514':
        return out(400, 'VALIDATION_ERROR', 'A value is outside the allowed range');
      case '22P02':
      case '22007':
      case '22003':
        return out(400, 'VALIDATION_ERROR', 'A value has an invalid format');
    }
    if ((e as { type?: string })?.type === 'entity.parse.failed') return out(400, 'BAD_REQUEST', 'Malformed JSON body');
    if ((e as { type?: string })?.type === 'entity.too.large') return out(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    return out(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Internal server error');
  }
}
