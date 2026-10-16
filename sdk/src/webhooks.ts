import { createHmac, timingSafeEqual } from 'node:crypto';

export type TirvonaEventType =
  | 'reservation.created'
  | 'reservation.confirmed'
  | 'reservation.updated'
  | 'reservation.cancelled'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'inventory.updated'
  | 'ping';

export interface TirvonaEvent<D = Record<string, any>> {
  /** Stable across retries: deduplicate on it. */
  id: string;
  type: TirvonaEventType | (string & {});
  apiVersion: string;
  createdAt: string;
  data: D;
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

/**
 * Verifies the `Tirvona-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * `rawBody` must be the exact bytes received (do NOT re-serialize parsed JSON). Constant-time comparison; rejects
 * timestamps older/newer than `toleranceSeconds` (default 300) to stop replays.
 */
export function verifyWebhookSignature(secret: string, header: string | undefined, rawBody: string | Buffer, opts: { toleranceSeconds?: number; nowMs?: number } = {}): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const candidates = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isInteger(t) || !candidates.length) return false;
  if (Math.abs((opts.nowMs ?? Date.now()) / 1000 - t) > (opts.toleranceSeconds ?? 300)) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return candidates.some((c) => {
    const got = Buffer.from(c, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** Verifies the signature and returns the parsed event; throws WebhookSignatureError otherwise. */
export function constructWebhookEvent<D = Record<string, any>>(secret: string, header: string | undefined, rawBody: string | Buffer, opts?: { toleranceSeconds?: number; nowMs?: number }): TirvonaEvent<D> {
  if (!verifyWebhookSignature(secret, header, rawBody, opts)) throw new WebhookSignatureError('Invalid webhook signature');
  return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as TirvonaEvent<D>;
}
