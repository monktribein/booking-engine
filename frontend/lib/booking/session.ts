/**
 * Per-tab booking state kept in sessionStorage (never localStorage: it must not outlive the tab).
 * Every accessor is wrapped in try/catch because storage can be unavailable (private mode, blocked cookies).
 */

const LAST_BOOKING_KEY = 'tirvona_last_booking';

export interface LastBooking {
  code: string;
  email: string;
}

function read(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the flow still works, it just cannot survive a reload */
  }
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Stable, order-independent fingerprint of the booking payload. */
export function fingerprint(payload: unknown): string {
  const s = JSON.stringify(payload, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/**
 * Idempotency-Key for POST /public/reservations. The same payload always reuses the same key (so a double
 * click, a retry after a network error, or a page reload returns the SAME reservation instead of creating a
 * second one); a changed payload gets a fresh key.
 */
export function idempotencyKeyFor(payload: unknown): string {
  const fp = fingerprint(payload);
  const storageKey = `tirvona_idem_${fp}`;
  const existing = read(storageKey);
  if (existing) return existing;
  const key = newKey();
  write(storageKey, key);
  return key;
}

const listeners = new Set<() => void>();

export function saveLastBooking(b: LastBooking): void {
  write(LAST_BOOKING_KEY, JSON.stringify(b));
  listeners.forEach((l) => l());
}

export function subscribeLastBooking(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Raw stored value; a string is a stable snapshot for useSyncExternalStore. */
export function lastBookingSnapshot(): string | null {
  return read(LAST_BOOKING_KEY);
}

export function loadLastBooking(code: string): LastBooking | null {
  const raw = read(LAST_BOOKING_KEY);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as LastBooking;
    return b.code === code ? b : null;
  } catch {
    return null;
  }
}
