import { JsonLogger } from '../src/common/json-logger';
import { bearer, createPropertyWithRooms, day, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { checkoutSignature, mockRazorpay, razorpayWebhook } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * Operational logging: JSON lines, request ids, route patterns instead of raw URLs, and nothing sensitive in the log
 * stream (tokens, e-mails, booking codes, signatures). Also the alertable payment-failure event.
 */
describe('Structured logs', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rzp: ReturnType<typeof mockRazorpay>;
  const out: string[] = [];
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  const entries = () => out.flatMap((c) => c.split('\n')).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeAll(async () => {
    process.env.LOG_FORMAT = 'json';
    t = await createTestApp({ LOG_FORMAT: 'json' });
    t.app.useLogger(new JsonLogger('tirvona-api')); // what main.ts does in production
    rzp = mockRazorpay();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 3);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => (out.push(String(c)), true)) as never);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => (out.push(String(c)), true)) as never);
  });
  afterAll(async () => {
    stdout.mockRestore();
    stderr.mockRestore();
    rzp.restore();
    delete process.env.LOG_FORMAT;
    await t.close();
  });

  it('every response carries an X-Request-Id; a sane incoming id is kept, a hostile one is replaced', async () => {
    const generated = await t.http().get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await t.http().get('/health').set('X-Request-Id', 'lb-req-0123456789');
    expect(kept.headers['x-request-id']).toBe('lb-req-0123456789');
    const hostile = await t.http().get('/health').set('X-Request-Id', 'bad id with spaces and "quotes"');
    expect(hostile.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('access log lines are JSON with the ROUTE PATTERN, status and duration; health probes are not logged', async () => {
    out.length = 0;
    await t.http().get('/health').expect(200);
    await t.http().get(`/properties/${s.propertyId}/room-types`).set(bearer(owner.token)).expect(200);
    await t.http().get('/properties/00000000-0000-4000-8000-000000000000').set(bearer(owner.token)).expect(404);
    const http = entries().filter((e) => e.event === 'http_request');
    expect(http.find((e) => e.route === '/health')).toBeUndefined();
    const ok = http.find((e) => String(e.route).endsWith('/properties/:propertyId/room-types'))!;
    expect(ok).toMatchObject({ level: 'info', method: 'GET', status: 200, service: 'tirvona-api' });
    expect(ok.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof ok.ms).toBe('number');
    const denied = http.find((e) => e.status === 404)!;
    expect(denied.level).toBe('warn');
    expect(JSON.stringify(denied)).not.toContain('000000000000000000000000'); // the raw id never appears
  });

  it('tokens, e-mails, booking codes, query strings and signatures never reach the log stream', async () => {
    out.length = 0;
    const email = 'private.guest@example.com';
    const booked = await t
      .http()
      .post('/public/reservations')
      .set('Idempotency-Key', 'obs-key-0000001')
      .send({ propertySlug: s.slug, checkIn: day(3), checkOut: day(5), adults: 2, rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }], guest: { firstName: 'Priya', lastName: 'Private', email, phone: '+447700900999' } })
      .expect(201);
    const code = booked.body.data.reservation.reservationCode;
    const orderId = booked.body.data.payment.orderId;
    await t.http().get(`/public/reservations/${code}`).query({ email }).expect(200);
    await t.http().post('/payments/verify').send({ razorpayOrderId: orderId, razorpayPaymentId: 'pay_OBS000001', razorpaySignature: checkoutSignature(orderId, 'pay_OBS000001') }).expect(200);
    await t.http().get('/auth/me').set('Authorization', `Bearer ${owner.token}`).expect(200);
    await t.http().get('/auth/me').set('Authorization', 'Bearer not-a-real-token').expect(401);
    await t.drain();

    const log = out.join('');
    for (const secret of [owner.token, owner.refreshToken, email, 'private.guest', code, checkoutSignature(orderId, 'pay_OBS000001'), '+447700900999']) {
      expect(log).not.toContain(secret);
    }
    expect(log).not.toMatch(/\?email=/);
    expect(entries().every((e) => typeof e.level === 'string' && typeof e.ts === 'string')).toBe(true); // every line is valid structured JSON
  });

  it('a failed payment emits the alertable payment_failed event (no guest data), tied to the reservation', async () => {
    const booked = await t
      .http()
      .post('/public/reservations')
      .set('Idempotency-Key', 'obs-key-0000002')
      .send({ propertySlug: s.slug, checkIn: day(7), checkOut: day(8), adults: 2, rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }], guest: { firstName: 'A', lastName: 'B', email: 'fail.guest@example.com', phone: '+447700900123' } })
      .expect(201);
    out.length = 0;
    const w = razorpayWebhook('payment.failed', { id: 'pay_FAILOBS01', order_id: booked.body.data.payment.orderId, amount: 1, currency: 'INR', error_description: 'Card declined' });
    await t.http().post('/payments/webhook').set(w.headers).send(w.raw).expect(200);
    await t.drain();
    const ev = entries().find((e) => e.event === 'payment_failed')!;
    expect(ev).toMatchObject({ level: 'warn', context: 'PaymentsService' });
    expect(ev.reservationId).toEqual(expect.any(String));
    expect(JSON.stringify(ev)).not.toContain('fail.guest');
  });
});
