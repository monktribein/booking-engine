import { PipeTransform } from '@nestjs/common';
import { DomainValidationError } from '../database/errors';

/** Any RFC 4122 uuid (versions 1-8). Ids are lower-case in the database; input is normalised to lower-case. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

/** Validates an id coming from a client and returns it normalised, or throws 400 VALIDATION_ERROR. */
export function toUuid(value: string, field = 'id'): string {
  if (!isUuid(value)) throw new DomainValidationError(`${field} must be a valid id`, { field });
  return value.toLowerCase();
}

/** Route-param pipe: '/reservations/:id' → uuid string, or 400 VALIDATION_ERROR. */
export class ParseUuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    return toUuid(value);
  }
}

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

/** Escapes LIKE/ILIKE wildcards so user text is matched literally (use with `escape '\'`, the default). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export function pageParams(page = 1, limit = 20) {
  const p = Math.max(1, Math.floor(page));
  const l = Math.min(100, Math.max(1, Math.floor(limit)));
  return { page: p, limit: l, skip: (p - 1) * l };
}
