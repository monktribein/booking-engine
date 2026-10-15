import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';
import { formatDateOnly } from './common/dates';

/**
 * A calendar date as a SQL `date` expression, for use in WHERE clauses: `.where('date', '>=', d(from))`.
 * Accepts a UTC-midnight Date or 'YYYY-MM-DD'. (Dates are passed as text and cast, never as JS Date objects, so the
 * server's time zone can never shift a day. For INSERT/UPDATE values use formatDateOnly(date) directly.)
 */
export const d = (value: Date | string): RawBuilder<Date> => sql<Date>`${typeof value === 'string' ? value : formatDateOnly(value)}::date`;

/** Row count of an UPDATE/DELETE as a plain number. */
export const affected = (r: { numUpdatedRows?: bigint; numDeletedRows?: bigint; numAffectedRows?: bigint }): number =>
  Number(r.numUpdatedRows ?? r.numDeletedRows ?? r.numAffectedRows ?? 0);

/**
 * Builds an UPDATE ... SET object from a PATCH body: undefined keys are skipped, keys listed in `json` are serialised
 * as jsonb text (arrays of objects, nested objects), strings are trimmed. `null` is kept (it clears a nullable column).
 */
export function setFrom(dto: object, opts: { json?: string[]; keep?: string[] } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dto)) {
    if (v === undefined) continue;
    if (opts.json?.includes(k)) out[k] = JSON.stringify(v);
    else if (typeof v === 'string' && !opts.keep?.includes(k)) out[k] = v.trim();
    else out[k] = v;
  }
  return out;
}
