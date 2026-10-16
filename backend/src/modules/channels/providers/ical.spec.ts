import { buildIcal, IcalError, parseIcal } from './ical';

const cal = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');
const ev = (lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');

describe('iCal reader', () => {
  it('reads all-day and date-time events, cancelled status and summaries', () => {
    const r = parseIcal(
      cal(
        ev(['UID:a1', 'DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270313', 'SUMMARY:Reserved']),
        ev(['UID:a2', 'DTSTART:20270320T140000Z', 'DTEND:20270322T100000Z', 'STATUS:CANCELLED']),
        ev(['UID:a3', 'DTSTART;VALUE=DATE:20270401', 'DURATION:P2D']),
        ev(['UID:a4', 'DTSTART;VALUE=DATE:20270410']),
      ),
    );
    expect(r.skipped).toEqual([]);
    expect(r.events).toEqual([
      { uid: 'a1', start: '2027-03-10', end: '2027-03-13', cancelled: false, summary: 'Reserved', lastModified: undefined },
      { uid: 'a2', start: '2027-03-20', end: '2027-03-22', cancelled: true, summary: undefined, lastModified: undefined },
      { uid: 'a3', start: '2027-04-01', end: '2027-04-03', cancelled: false, summary: undefined, lastModified: undefined },
      { uid: 'a4', start: '2027-04-10', end: '2027-04-11', cancelled: false, summary: undefined, lastModified: undefined },
    ]);
  });

  it('unfolds long lines and unescapes text', () => {
    const r = parseIcal(cal(ev(['UID:long', 'DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270311', 'SUMMARY:Reserved\\, for Mr\\;', ' Sharma'])));
    expect(r.events[0].summary).toBe('Reserved, for Mr;Sharma');
  });

  it('skips what it cannot interpret instead of guessing', () => {
    const r = parseIcal(
      cal(
        ev(['UID:rec', 'DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270311', 'RRULE:FREQ=WEEKLY']),
        ev(['DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270311']),
        ev(['UID:bad', 'DTSTART;VALUE=DATE:20271340', 'DTEND;VALUE=DATE:20271341']),
        ev(['UID:back', 'DTSTART;VALUE=DATE:20270312', 'DTEND;VALUE=DATE:20270310']),
        ev(['UID:ok', 'DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270311']),
      ),
    );
    expect(r.events.map((e) => e.uid)).toEqual(['ok']);
    expect(r.skipped.map((s) => s.reason)).toEqual(['recurring events are not supported', 'event without UID', 'DTSTART missing or not a valid date', 'DTEND is not after DTSTART']);
  });

  it('rejects documents that are not complete calendars', () => {
    expect(() => parseIcal('<html>login page</html>')).toThrow(IcalError);
    expect(() => parseIcal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n')).toThrow(/truncated/);
    expect(() => parseIcal('BEGIN:VCALENDAR\r\n' + 'X-A:' + 'a'.repeat(5000) + '\r\nEND:VCALENDAR')).toThrow(/too long/);
  });

  it('caps the number of events', () => {
    const many = Array.from({ length: 5100 }, (_, i) => ev([`UID:e${i}`, 'DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270311']));
    expect(() => parseIcal(cal(...many))).toThrow(/more than/);
  });

  it('an empty but valid calendar is valid', () => {
    expect(parseIcal(cal()).events).toEqual([]);
  });
});

describe('iCal writer', () => {
  it('writes a feed that its own reader accepts, with no guest data and CRLF folding', () => {
    const text = buildIcal({ name: 'Seaside, Inn — Deluxe', events: [{ uid: 'f1-2027-03-10@tirvona', start: '2027-03-10', end: '2027-03-13', summary: 'Not available' }], now: new Date('2027-01-01T00:00:00Z') });
    expect(text).toContain('DTSTART;VALUE=DATE:20270310');
    expect(text).toContain('DTEND;VALUE=DATE:20270313');
    expect(text).toContain('X-WR-CALNAME:Seaside\\, Inn');
    expect(text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(parseIcal(text).events).toMatchObject([{ uid: 'f1-2027-03-10@tirvona', start: '2027-03-10', end: '2027-03-13' }]);
  });
});
