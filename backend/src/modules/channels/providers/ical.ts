/**
 * A small, strict RFC 5545 reader and writer for availability calendars. It reads only what an availability feed needs
 * (VEVENT: UID, DTSTART, DTEND, STATUS, SUMMARY, LAST-MODIFIED) and ignores the rest. It is deliberately not a general calendar
 * library: no recurrence expansion (RRULE makes an event unsupported rather than guessed at), no time zone database, no includes.
 *
 * What an iCal feed can carry is only "these dates are taken". It cannot carry prices, guests, payments or restrictions, and
 * nothing in this module pretends otherwise.
 */

export interface IcalEvent {
  uid: string;
  /** First night, YYYY-MM-DD. */
  start: string;
  /** Check-out date (exclusive), YYYY-MM-DD. */
  end: string;
  cancelled: boolean;
  summary?: string;
  lastModified?: string;
}

export interface IcalParseResult {
  events: IcalEvent[];
  skipped: { uid?: string; reason: string }[];
}

export class IcalError extends Error {}

const MAX_EVENTS = 5000;
const MAX_LINE = 4000;

/** Unfolds RFC 5545 content lines (a line that starts with a space or tab continues the previous one). */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

const unescapeText = (v: string) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

function parseDate(value: string, params: string): string | null {
  const v = value.trim();
  // DATE: 20270310  (VALUE=DATE)   or   DATE-TIME: 20270310T140000Z / 20270310T140000
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  void params;
  return iso;
}

export function parseIcal(text: string): IcalParseResult {
  if (typeof text !== 'string' || !/^\s*BEGIN:VCALENDAR/i.test(text)) throw new IcalError('not an iCalendar document (no BEGIN:VCALENDAR)');
  const lines = unfold(text);
  const events: IcalEvent[] = [];
  const skipped: IcalParseResult['skipped'] = [];
  let cur: Record<string, { value: string; params: string }> | null = null;
  let sawEnd = false;
  for (const line of lines) {
    if (line.length > MAX_LINE) throw new IcalError('line too long');
    const upper = line.toUpperCase();
    if (upper === 'END:VCALENDAR') sawEnd = true;
    if (upper === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (cur) {
        const uid = cur.UID?.value?.trim();
        if (!uid) skipped.push({ reason: 'event without UID' });
        else if (cur.RRULE) skipped.push({ uid, reason: 'recurring events are not supported' });
        else {
          const start = cur.DTSTART ? parseDate(cur.DTSTART.value, cur.DTSTART.params) : null;
          let end = cur.DTEND ? parseDate(cur.DTEND.value, cur.DTEND.params) : null;
          if (!start) skipped.push({ uid, reason: 'DTSTART missing or not a valid date' });
          else {
            if (!end && cur.DURATION) {
              const dur = /^P(\d+)D$/.exec(cur.DURATION.value.trim());
              if (dur) end = new Date(Date.parse(`${start}T00:00:00Z`) + Number(dur[1]) * 86_400_000).toISOString().slice(0, 10);
            }
            if (!end) end = new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10); // a one-day event
            if (end <= start) skipped.push({ uid, reason: 'DTEND is not after DTSTART' });
            else {
              events.push({
                uid: uid.slice(0, 200),
                start,
                end,
                cancelled: (cur.STATUS?.value ?? '').trim().toUpperCase() === 'CANCELLED',
                summary: cur.SUMMARY ? unescapeText(cur.SUMMARY.value).slice(0, 120) : undefined,
                lastModified: cur['LAST-MODIFIED']?.value?.trim(),
              });
            }
          }
        }
      }
      cur = null;
      if (events.length > MAX_EVENTS) throw new IcalError(`more than ${MAX_EVENTS} events`);
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const head = line.slice(0, idx);
    const [nameRaw, ...paramParts] = head.split(';');
    const name = nameRaw.toUpperCase();
    if (!cur[name]) cur[name] = { value: line.slice(idx + 1), params: paramParts.join(';') };
  }
  if (!sawEnd) throw new IcalError('the calendar is truncated (no END:VCALENDAR)');
  return { events, skipped };
}

// ------------------------------------------------------------------ writer

const escapeText = (v: string) => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const compact = (d: string) => d.replace(/-/g, '');

/** Folds a content line to 75 octets as the RFC requires. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

/** An availability feed: one all-day event per taken stay. Deliberately carries no guest data. */
export function buildIcal(opts: { name: string; events: { uid: string; start: string; end: string; summary: string }[]; now?: Date }): string {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tirvona//Availability//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(opts.name)}`];
  for (const e of opts.events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${compact(e.start)}`, `DTEND;VALUE=DATE:${compact(e.end)}`, `SUMMARY:${escapeText(e.summary)}`, 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
