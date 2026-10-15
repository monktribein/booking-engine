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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The database calls every primary key `id`. The dashboard API and the web app have always called it `_id`, so on the
 * way out an object whose `id` is a uuid gets `_id` instead. The versioned public API (/v1) is exempt: its handlers
 * return exactly the field names of the documented contract.
 */
export function renameIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameIds);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id' && typeof v === 'string' && UUID.test(v)) out._id = v;
      else out[k] = renameIds(v);
    }
    return out;
  }
  return value;
}

/** Wraps every successful response as { success: true, data }. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<SuccessBody<unknown>> {
    const isV1 = /^\/v1(\/|\?|$)/.test(ctx.switchToHttp().getRequest<{ originalUrl?: string }>().originalUrl ?? '');
    return next.handle().pipe(
      map((data) => {
        // JSON round-trip turns Dates into ISO strings and class instances into plain objects.
        const plain = stripSensitive(data === undefined ? null : JSON.parse(JSON.stringify(data)));
        return { success: true as const, data: isV1 ? plain : renameIds(plain) };
      }),
    );
  }
}
