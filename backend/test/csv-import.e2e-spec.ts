import { parseCsv } from '../src/modules/reservations/csv-import';
import { bearer, createMember, createPropertyWithRooms, day, inventoryFor, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

const iso = (n: number) => day(n);
const dmy = (n: number) => day(n).split('-').reverse().join('/');
const COLS = { reference: 'Ref', checkIn: 'Arrival', checkOut: 'Departure', adults: 'Adults', guestFirstName: 'First', guestLastName: 'Last', email: 'Email', phone: 'Phone', total: 'Total', notes: 'Notes' };

describe('CSV reader', () => {
  it('handles quotes, escaped quotes, embedded newlines, BOM, CRLF and detects the delimiter', () => {
    const r = parseCsv('﻿Ref;Name;Note\r\nA1;"Sharma, R";"he said ""hi""\nsecond line"\r\n\r\nA2;Lee;ok');
    expect(r.header).toEqual(['Ref', 'Name', 'Note']);
    expect(r.rows.map((x) => x.cells)).toEqual([['A1', 'Sharma, R', 'he said "hi"\nsecond line'], ['A2', 'Lee', 'ok']]);
    expect(r.rows[1].line).toBe(5);
  });
  it('detects tabs and rejects unclosed quotes, empty files and oversized input', () => {
    expect(parseCsv('a\tb\n1\t2').rows[0].cells).toEqual(['1', '2']);
    expect(() => parseCsv('a,b\n"1,2')).toThrow(/not closed/);
    expect(() => parseCsv('')).toThrow(/empty/);
    expect(() => parseCsv('a\n' + 'x\n'.repeat(1001))).toThrow(/More than 1000/);
    expect(() => parseCsv('a'.repeat(1024 * 1024 + 1))).toThrow(/larger than/);
  });
});

describe('CSV booking import', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;

  const post = (token: string, csv: string, over: Record<string, unknown> = {}) =>
    t.http().post(`/properties/${s.propertyId}/reservations/import`).set(bearer(token)).send({ csv, roomTypeId: s.roomTypeId, columns: COLS, dateFormat: 'YYYY-MM-DD', dryRun: true, ...over });
  const count = async () => Number((await t.db.selectFrom('reservations').select((eb) => eb.fn.countAll<string>().as('n')).where('propertyId', '=', s.propertyId).executeTakeFirstOrThrow()).n);
  const file = (rows: string[]) => ['Ref,Arrival,Departure,Adults,First,Last,Email,Phone,Total,Notes', ...rows].join('\n');

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t, 'csv');
    s = await createPropertyWithRooms(t, owner.token, 2);
  });
  afterAll(() => t.close());

  it('a dry run checks every row and writes nothing', async () => {
    const csv = file([
      `R-1,${iso(5)},${iso(7)},2,Asha,Verma,asha@example.com,+919811111111,"7,000.50",Late arrival`,
      `R-2,${iso(5)},${iso(7)},1,Ben,Lee,,,5000,`,
      `R-3,${iso(5)},${iso(7)},1,Cara,Ng,,,5000,`, // third booking on a 2-room type
      `R-4,31/02/2027,${iso(7)},1,Dev,,,,100,`,
      `R-1,${iso(9)},${iso(10)},1,Dup,,,,100,`,
      `R-6,${iso(9)},${iso(10)},1,Eve,Ray,not-an-email,12345,abc,`,
      `bad ref!,${iso(9)},${iso(10)},1,Fay,,,,100,`,
      `R-8,${iso(-3)},${iso(-1)},1,Gus,,,,100,`,
      `R-9,${iso(70)},${iso(71)},1,Hal,,,,100,`,
    ]);
    const before = await count();
    const res = await post(owner.token, csv).expect(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(await count()).toBe(before); // nothing written
    const rows = res.body.data.rows as { line: number; status: string; errors: string[] }[];
    expect(rows.map((r) => r.status)).toEqual(['OK', 'OK', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
    expect(rows[2].errors.join()).toMatch(/no room left/);
    expect(rows[3].errors.join()).toMatch(/check-in is not a valid YYYY-MM-DD/);
    expect(rows[4].errors.join()).toMatch(/appears earlier/);
    expect(rows[5].errors.join()).toMatch(/email is not valid.*phone must be.*total is not a valid amount/);
    expect(rows[6].errors.join()).toMatch(/reference/);
    expect(rows[7].errors.join()).toMatch(/in the past/);
    expect(rows[8].errors.join()).toMatch(/sellable horizon/);
    expect(rows[0].line).toBe(2);
    expect(res.body.data.totals).toMatchObject({ rows: 9, ok: 2, errors: 7, imported: 0 });
    // the preview never echoes contact details back
    expect(JSON.stringify(res.body)).not.toMatch(/asha@example|9811111111/);
  });

  it('imports the valid rows through the normal reservation transaction and reports each row', async () => {
    const csv = file([
      `R-1,${iso(5)},${iso(7)},2,Asha,Verma,asha@example.com,+919811111111,"7,000.50",Late arrival`,
      `R-2,${iso(5)},${iso(7)},1,Ben,Lee,,,5000,`,
      `R-3,${iso(5)},${iso(7)},1,Cara,Ng,,,5000,`,
    ]);
    const res = await post(owner.token, csv, { dryRun: false }).expect(200);
    expect(res.body.data.rows.map((r: { status: string }) => r.status)).toEqual(['IMPORTED', 'IMPORTED', 'ERROR']);
    const rows = await t.db.selectFrom('reservations').selectAll().where('propertyId', '=', s.propertyId).where('source', '=', 'CSV_IMPORT').orderBy('externalReservationId').execute();
    expect(rows.map((r) => r.externalReservationId)).toEqual(['R-1', 'R-2']);
    expect(rows[0]).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'UNPAID' });
    expect(Number(rows[0].total)).toBe(700050 + Math.round(700050 * 0.05)); // the stay price plus the property's tax
    expect(Number(rows[0].subtotal)).toBe(700050);
    const inv = await inventoryFor(t, owner.token, s, iso(5), iso(7));
    expect(inv.map((r: { available: number }) => r.available)).toEqual([0, 0]);
    expect((await t.db.selectFrom('auditLogs').select('action').where('propertyId', '=', s.propertyId).execute()).map((a) => a.action)).toEqual(expect.arrayContaining(['reservations.csv_preview', 'reservations.csv_import']));
  });

  it('repeating the same file is safe: imported rows are recognised as duplicates, so only corrected rows are added', async () => {
    const before = await count();
    const again = await post(owner.token, file([`R-1,${iso(5)},${iso(7)},2,Asha,Verma,,,7000.50,`, `R-2,${iso(5)},${iso(7)},1,Ben,Lee,,,5000,`]), { dryRun: false }).expect(200);
    expect(again.body.data.rows.map((r: { status: string }) => r.status)).toEqual(['DUPLICATE', 'DUPLICATE']);
    expect(await count()).toBe(before);
    const fixed = await post(owner.token, file([`R-1,${iso(5)},${iso(7)},2,Asha,Verma,,,7000.50,`, `R-3,${iso(10)},${iso(12)},1,Cara,Ng,,,5000,`]), { dryRun: false }).expect(200);
    expect(fixed.body.data.rows.map((r: { status: string }) => r.status)).toEqual(['DUPLICATE', 'IMPORTED']);
    expect(await count()).toBe(before + 1);
  });

  it('understands other date formats and delimiters and quoted text', async () => {
    const csv = ['Ref;Arrival;Departure;Adults;First;Last;Email;Phone;Total;Notes', `D-1;${dmy(20)};${dmy(22)};2;"Mary, Jane";Watson;;;"₹ 8,000";"Needs a cot,\nquiet room"`].join('\n');
    const res = await post(owner.token, csv, { dateFormat: 'DD/MM/YYYY', dryRun: false }).expect(200);
    expect(res.body.data.rows[0].status).toBe('IMPORTED');
    const r = await t.db.selectFrom('reservations').select(['specialRequests', 'guest']).where('externalReservationId', '=', 'D-1').executeTakeFirstOrThrow();
    expect(r.specialRequests).toBe('Needs a cot,\nquiet room');
    expect((r.guest as { firstName: string }).firstName).toBe('Mary, Jane');
  });

  it('refuses unknown columns, bad files and other tenants', async () => {
    await post(owner.token, file([]), { columns: { ...COLS, total: 'Price' } }).expect(400);
    await post(owner.token, '').expect((r) => expect([400, 422]).toContain(r.status));
    await post(owner.token, 'a,b\n"1,2').expect(400);
    await post(owner.token, file([])).expect(200); // header only: nothing to do
    const other = await registerOwner(t, 'csv-other');
    await post(other.token, file([`X-1,${iso(5)},${iso(6)},1,A,,,,100,`]), { dryRun: false }).expect((r) => expect([403, 404]).toContain(r.status));
    await post(owner.token, file([]), { roomTypeId: '11111111-1111-4111-8111-111111111111' }).expect(404);
  });

  it('needs the right to set prices: front-desk staff cannot import', async () => {
    const reception = await createMember(t, owner, 'RECEPTION', s.propertyId);
    await post(reception.token, file([`Z-1,${iso(30)},${iso(31)},1,A,,,,100,`]), { dryRun: false }).expect(403);
  });
});
