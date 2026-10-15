/**
 * SANDBOX ONLY. Preloaded with `node --require` by scripts/dev-sandbox.ts.
 * Answers https://api.razorpay.com/* locally so the whole checkout can be exercised without a Razorpay account
 * and without any network call to the real gateway. Everything else goes to the real fetch.
 * It refuses to load in production.
 */
if (process.env.NODE_ENV === 'production') throw new Error('sandbox-razorpay-shim must never run in production');

const realFetch = globalThis.fetch;
const refunds = new Map();
let seq = 0;
const id = (p) => `${p}_SBX${String(++seq).padStart(8, '0')}`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== 'api.razorpay.com') return realFetch(input, init);
  const method = (init && init.method) || 'GET';
  const body = init && init.body ? JSON.parse(String(init.body)) : {};
  if (method === 'POST' && url.pathname === '/v1/orders') {
    return json(200, { id: id('order'), amount: body.amount, currency: body.currency, status: 'created', receipt: body.receipt });
  }
  const m = url.pathname.match(/^\/v1\/payments\/([^/]+)\/refunds?$/);
  if (m && method === 'GET') return json(200, { items: refunds.get(m[1]) || [] });
  if (m && method === 'POST') {
    const r = { id: id('rfnd'), status: 'processed', notes: body.notes };
    refunds.set(m[1], [...(refunds.get(m[1]) || []), r]);
    return json(200, { ...r, amount: body.amount });
  }
  return json(404, { error: { description: 'not available in the sandbox gateway' } });
};
