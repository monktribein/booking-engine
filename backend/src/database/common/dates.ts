/**
 * Calendar-date convention
 * ------------------------
 * Hotel dates (inventory.date, checkIn, checkOut, restriction dates, block
 * ranges) are *calendar dates in the property's local time zone*, not
 * instants. They are stored as BSON Dates at 00:00:00.000Z of that calendar
 * day, so "2026-10-05" is always ISODate("2026-10-05T00:00:00Z") no matter
 * where the property is. Never build them with `new Date()` arithmetic in a
 * local zone; use these helpers.
 *
 * Ranges are half-open: a stay [checkIn, checkOut) consumes the nights
 * checkIn .. checkOut-1. A block [startDate, endDate) works the same way.
 */

import { DomainValidationError } from '../errors';

const DAY_MS = 86_400_000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateInput = string | Date;

export function isDateOnly(value: unknown): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime()) && value.getTime() % DAY_MS === 0;
}

/** Parse "YYYY-MM-DD" (or an already-normalised Date) into a UTC-midnight Date. */
export function toDateOnly(input: DateInput): Date {
  if (input instanceof Date) {
    if (!isDateOnly(input)) throw new DomainValidationError(`Expected a UTC-midnight date, got ${input.toISOString()}`);
    return new Date(input.getTime());
  }
  const m = DATE_ONLY_RE.exec(input);
  if (!m) throw new DomainValidationError(`Expected YYYY-MM-DD, got "${input}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new DomainValidationError(`Invalid calendar date "${input}"`);
  }
  return date;
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function nightsBetween(checkIn: Date, checkOut: Date): number {
  return Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS);
}

/** Every night of a half-open stay [checkIn, checkOut). */
export function eachNight(checkIn: Date, checkOut: Date): Date[] {
  const n = nightsBetween(checkIn, checkOut);
  return Array.from({ length: Math.max(n, 0) }, (_, i) => addDays(checkIn, i));
}

/** Today's calendar date in an IANA time zone, as a UTC-midnight Date. */
export function todayIn(timeZone: string, now: Date = new Date()): Date {
  // en-CA formats as YYYY-MM-DD.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return toDateOnly(ymd);
}

/** Offset of `timeZone` from UTC at instant `at`, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which local wall time `hhmm` occurs on calendar `date` in `timeZone`. */
export function localDateTimeToInstant(date: Date, hhmm: string, timeZone: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const wallAsUtc = date.getTime() + (h * 60 + m) * 60_000;
  const first = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone);
  // Second pass settles DST transitions.
  return new Date(wallAsUtc - zoneOffsetMs(new Date(first), timeZone));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
