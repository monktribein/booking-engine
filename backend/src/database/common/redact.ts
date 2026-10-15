/**
 * Scrubs secrets from free-form metadata before it is persisted
 * (sync_logs, webhook error context, payment metadata, audit before/after).
 * The schemas call this in pre-validate hooks, so a careless caller cannot
 * write a token into a log.
 */

// Keys containing these fragments are redacted: accessToken, refresh_token, passwordHash, X-Api-Key...
const SECRET_KEY_FRAGMENT_RE =
  /(password|passwd|secret|token|authorization|api[-_]?key|private[-_]?key|cookie|signature|card[-_]?number)/i;
// Short keys that are only redacted on an exact match (so "company" survives but "pan" does not).
const SECRET_KEY_EXACT_RE = /^(pass|pan|cvv|cvc|otp|pin)$/i;
const isSecretKey = (k: string) => SECRET_KEY_FRAGMENT_RE.test(k) || SECRET_KEY_EXACT_RE.test(k);

// 13-19 digit runs, optionally separated by spaces or dashes: likely card numbers.
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

const MAX_DEPTH = 8;
export const REDACTED = '[REDACTED]';

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function scrubString(s: string): string {
  return s.replace(CARD_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && luhn(digits) ? REDACTED : m;
  });
}

export function redactSecrets<T>(value: T, depth = 0): T {
  if (value == null || depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return scrubString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  if (value instanceof Date || typeof value !== 'object') return value;
  // Leave BSON types (ObjectId, Decimal128, ...) untouched.
  if ((value as { _bsontype?: string })._bsontype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? REDACTED : redactSecrets(v, depth + 1);
  }
  return out as T;
}
