import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Field names that must never leave the API, whatever a handler returns.
 * Schemas already exclude them (select:false), so this is a second net.
 */
const SENSITIVE_KEYS = new Set([
  'passwordHash',
  'refreshTokenHash',
  'tokenHash',
  'accessTokenEncrypted',
  'refreshTokenEncrypted',
  'oauthStateHash',
  'numberEncrypted',
  'encryptedLink',
  'keyHash',
  'secretEncrypted',
  '__v',
]);

export function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!SENSITIVE_KEYS.has(k)) out[k] = stripSensitive(v);
    return out;
  }
  return value;
}

export interface SuccessBody<T> {
  success: true;
  data: T;
}

/** Wraps every successful response as { success: true, data }. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<SuccessBody<unknown>> {
    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        // JSON round-trip turns ObjectIds into hex strings and hydrated docs into plain objects.
        data: stripSensitive(data === undefined ? null : JSON.parse(JSON.stringify(data))),
      })),
    );
  }
}
