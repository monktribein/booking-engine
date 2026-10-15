/**
 * Bookings a guest chose to remember on THIS device (localStorage). Guests have no accounts: a booking is found with its
 * code + the e-mail used to book, so remembering one means keeping those two values (plus display details) in the browser.
 * It is strictly opt-in, per booking, and removable. Every accessor is wrapped in try/catch because storage can be
 * unavailable (private mode, blocked cookies), in which case the feature simply shows nothing.
 */

const KEY = 'tirvona_recent_bookings';
const MAX = 10;

export interface RecentBooking {
  code: string;
  email: string;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  savedAt: number;
}

const valid = (b: unknown): b is RecentBooking => {
  const x = b as Partial<RecentBooking> | null;
  return !!x && typeof x.code === 'string' && /^TRV-[0-9A-Z]{8}$/.test(x.code) && typeof x.email === 'string' && typeof x.propertyName === 'string' && typeof x.checkIn === 'string' && typeof x.checkOut === 'string' && typeof x.savedAt === 'number';
};

export function listRecentBookings(): RecentBooking[] {
  try {
    if (typeof window === 'undefined') return [];
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function store(list: RecentBooking[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
    window.dispatchEvent(new Event('tirvona:recent-bookings'));
  } catch {
    /* storage unavailable: nothing is remembered */
  }
}

export function isRemembered(code: string): boolean {
  return listRecentBookings().some((b) => b.code === code);
}

export function rememberBooking(b: Omit<RecentBooking, 'savedAt'>): void {
  store([{ ...b, email: b.email.trim().toLowerCase(), savedAt: Date.now() }, ...listRecentBookings().filter((x) => x.code !== b.code)]);
}

export function forgetBooking(code: string): void {
  store(listRecentBookings().filter((b) => b.code !== code));
}

export function forgetAllBookings(): void {
  store([]);
}

/** For useSyncExternalStore: a stable string snapshot plus a subscription to changes (this tab and other tabs). */
export const recentBookingsSnapshot = (): string => {
  try {
    return typeof window === 'undefined' ? '[]' : window.localStorage.getItem(KEY) ?? '[]';
  } catch {
    return '[]';
  }
};
export function subscribeRecentBookings(cb: () => void): () => void {
  window.addEventListener('tirvona:recent-bookings', cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener('tirvona:recent-bookings', cb);
    window.removeEventListener('storage', cb);
  };
}
