import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { TirvonaClient, TirvonaError, constructWebhookEvent, verifyWebhookSignature, WebhookSignatureError } from '../src';

const KEY = 'tvk_abcdefgh_' + 'x'.repeat(43);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function fakeFetch(handler: (url: URL, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: URL | string, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return handler(new URL(String(input)), init, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}
const client = (f: typeof fetch, extra: Record<string, unknown> = {}) => new TirvonaClient({ apiKey: KEY, baseUrl: 'https://api.test/', fetch: f, maxRetries: 2, ...extra });
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

test('rejects a non-Tirvona key and a missing base URL', () => {
  assert.throws(() => new TirvonaClient({ apiKey: 'sk_live_123', baseUrl: 'https://x' }), /tvk_/);
  assert.throws(() => new TirvonaClient({ apiKey: KEY, baseUrl: '' }), /baseUrl/);
});

test('sends the key as a Bearer token, unwraps { data } and builds query strings', async () => {
  const { fn, calls } = fakeFetch(() => json(200, { success: true, data: [{ roomTypeId: 'rt1', ratePlans: [] }] }));
  const out = await client(fn).searchAvailability('radha-ashram', { checkIn: '2026-10-05', checkOut: '2026-10-07', adults: 2, promoCode: undefined });
  assert.equal(out[0].roomTypeId, 'rt1');
  assert.equal(calls[0].url.href, 'https://api.test/v1/properties/radha-ashram/availability?checkIn=2026-10-05&checkOut=2026-10-07&adults=2');
  assert.equal(headersOf(calls[0].init).Authorization, `Bearer ${KEY}`);
});

test('createReservation always sends an Idempotency-Key (generated, or the caller\'s)', async () => {
  const { fn, calls } = fakeFetch(() => json(201, { success: true, data: { reservation: { reservationCode: 'TRV-AAAAAAAA' }, payment: null, created: true } }));
  const input = { propertySlug: 'p', checkIn: '2026-10-05', checkOut: '2026-10-06', adults: 1, rooms: [{ roomTypeId: 'a', ratePlanId: 'b', quantity: 1 }], guest: { firstName: 'A', lastName: 'B', email: 'a@b.co', phone: '+911234567890' } };
  await client(fn).createReservation(input);
  await client(fn).createReservation(input, { idempotencyKey: 'my-key-0001' });
  assert.match(headersOf(calls[0].init)['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(headersOf(calls[1].init)['Idempotency-Key'], 'my-key-0001');
  assert.equal(JSON.parse(String(calls[1].init.body)).propertySlug, 'p');
});

test('API errors become TirvonaError with status, code and details; 4xx is not retried', async () => {
  const { fn, calls } = fakeFetch(() => json(409, { success: false, error: { code: 'ROOM_NOT_AVAILABLE', message: 'Sold out', details: { night: '2026-10-05' } } }));
  await assert.rejects(client(fn).getReservation('TRV-AAAAAAAA'), (e: unknown) => {
    assert.ok(e instanceof TirvonaError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'ROOM_NOT_AVAILABLE');
    assert.deepEqual(e.details, { night: '2026-10-05' });
    return true;
  });
  assert.equal(calls.length, 1);
});

test('retries 5xx and 429 (honouring Retry-After) for GET and for idempotent POST, then succeeds', async () => {
  const { fn, calls } = fakeFetch((_u, _i, n) => (n === 1 ? json(503, { success: false, error: { code: 'X', message: 'down' } }) : n === 2 ? json(429, { success: false, error: { code: 'RATE_LIMITED', message: 'slow' } }, { 'Retry-After': '0' }) : json(200, { success: true, data: [] })));
  assert.deepEqual(await client(fn).listProperties(), []);
  assert.equal(calls.length, 3);
});

test('gives up after maxRetries and reports the last error', async () => {
  const { fn, calls } = fakeFetch(() => json(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }));
  await assert.rejects(client(fn, { maxRetries: 1 }).listProperties(), (e: unknown) => e instanceof TirvonaError && e.status === 500);
  assert.equal(calls.length, 2);
});

test('transport failures surface as NETWORK_ERROR after retries', async () => {
  const { fn, calls } = fakeFetch(() => {
    throw new Error('ECONNRESET');
  });
  await assert.rejects(client(fn, { maxRetries: 1 }).listProperties(), (e: unknown) => e instanceof TirvonaError && e.code === 'NETWORK_ERROR' && e.status === 0);
  assert.equal(calls.length, 2);
});

test('cancel posts the reason and is retry-safe; path segments are encoded', async () => {
  const { fn, calls } = fakeFetch((_u, _i, n) => (n === 1 ? json(502, { success: false, error: { code: 'BAD_GATEWAY', message: 'x' } }) : json(200, { success: true, data: { alreadyCancelled: false, refunds: [], reservation: {} } })));
  await client(fn).cancelReservation('TRV-A/B', 'changed plans');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, '/v1/reservations/TRV-A%2FB/cancel');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { reason: 'changed plans' });
});

// ------------------------------------------------------------------ webhooks

const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const BODY = JSON.stringify({ id: 'evt_1', type: 'reservation.confirmed', apiVersion: 'v1', createdAt: '2026-10-15T00:00:00.000Z', data: { reservation: { reservationCode: 'TRV-AAAAAAAA' } } });

test('verifies a valid signature and parses the event', () => {
  const t = Math.floor(Date.now() / 1000);
  const ev = constructWebhookEvent('whsec_s', sign('whsec_s', t, BODY), BODY);
  assert.equal(ev.id, 'evt_1');
  assert.equal(ev.data.reservation.reservationCode, 'TRV-AAAAAAAA');
  assert.ok(verifyWebhookSignature('whsec_s', sign('whsec_s', t, BODY), Buffer.from(BODY)));
});

test('rejects tampered bodies, wrong secrets, missing headers, malformed headers and stale timestamps', () => {
  const t = Math.floor(Date.now() / 1000);
  const good = sign('whsec_s', t, BODY);
  assert.equal(verifyWebhookSignature('whsec_s', good, BODY.replace('confirmed', 'cancelled')), false);
  assert.equal(verifyWebhookSignature('whsec_other', good, BODY), false);
  assert.equal(verifyWebhookSignature('whsec_s', undefined, BODY), false);
  assert.equal(verifyWebhookSignature('whsec_s', 'garbage', BODY), false);
  assert.equal(verifyWebhookSignature('whsec_s', `t=${t},v1=zz`, BODY), false);
  assert.equal(verifyWebhookSignature('whsec_s', sign('whsec_s', t - 3600, BODY), BODY), false); // an hour old
  assert.equal(verifyWebhookSignature('whsec_s', sign('whsec_s', t - 3600, BODY), BODY, { toleranceSeconds: 7200 }), true);
  assert.throws(() => constructWebhookEvent('whsec_s', 'nope', BODY), WebhookSignatureError);
});

test('accepts any of several v1 signatures (secret rotation)', () => {
  const t = Math.floor(Date.now() / 1000);
  const oldSig = sign('whsec_old', t, BODY).split(',')[1];
  const newSig = sign('whsec_new', t, BODY).split(',')[1];
  assert.equal(verifyWebhookSignature('whsec_new', `t=${t},${oldSig},${newSig}`, BODY), true);
});
