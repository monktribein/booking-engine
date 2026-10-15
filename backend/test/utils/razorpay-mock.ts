import { createHmac, randomBytes } from 'node:crypto';
import { TEST_SECRETS } from './test-app';

export interface RazorpayCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/**
 * Stubs Razorpay's REST API at the fetch layer (orders, refunds) and records
 * calls. Signatures in tests use the real HMAC scheme with test secrets.
 */
export function mockRazorpay() {
  const calls: RazorpayCall[] = [];
  const refunds = new Map<string, { id: string; status: string; notes?: Record<string, string> }[]>();
  const realFetch = globalThis.fetch;
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.razorpay.com') return realFetch(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && url.pathname === '/v1/orders') {
      return json(200, { id: `order_${randomBytes(6).toString('hex')}`, amount: body.amount, currency: body.currency, status: 'created' });
    }
    const m = url.pathname.match(/^\/v1\/payments\/([^/]+)\/refunds?$/);
    if (m && method === 'GET') return json(200, { items: refunds.get(m[1]) ?? [] });
    if (m && method === 'POST') {
      const r = { id: `rfnd_${randomBytes(6).toString('hex')}`, status: 'processed', notes: body.notes };
      refunds.set(m[1], [...(refunds.get(m[1]) ?? []), r]);
      return json(200, { ...r, amount: body.amount });
    }
    return json(404, { error: { description: 'not mocked' } });
  });
  return { calls, restore: () => spy.mockRestore() };
}

export const checkoutSignature = (orderId: string, paymentId: string) =>
  createHmac('sha256', TEST_SECRETS.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

export function razorpayWebhook(event: string, entity: Record<string, unknown>, eventId = `evt_${randomBytes(6).toString('hex')}`) {
  const key = event.startsWith('refund') ? 'refund' : 'payment';
  const raw = JSON.stringify({ entity: 'event', event, payload: { [key]: { entity } } });
  const signature = createHmac('sha256', TEST_SECRETS.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  return { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId } };
}
