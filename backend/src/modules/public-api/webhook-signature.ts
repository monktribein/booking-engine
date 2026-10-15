import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing scheme (Stripe-style, so existing verification code transfers):
 *   Tirvona-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the endpoint secret>
 * Verify against the RAW request body, compare in constant time, and reject timestamps outside a tolerance
 * to stop replays. During secret rotation a header may hold several v1= values; any match is valid.
 */
export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

export function verifySignature(secret: string, header: string, body: string, opts: { toleranceSeconds?: number; nowMs?: number } = {}): boolean {
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const candidates = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isInteger(t) || !candidates.length) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs((opts.nowMs ?? Date.now()) / 1000 - t) > tolerance) return false;
  const expected = Buffer.from(computeSignature(secret, t, body), 'hex');
  return candidates.some((c) => {
    const got = Buffer.from(c, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
