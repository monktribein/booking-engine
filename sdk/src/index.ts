/**
 * Tirvona API client (v1). Zero dependencies; needs Node 18+ (global fetch) or any runtime with fetch.
 * Server-side only: an API key is a secret and must never ship in browser or mobile code.
 */
import { randomUUID } from 'node:crypto';

export { verifyWebhookSignature, constructWebhookEvent, WebhookSignatureError } from './webhooks';
export type { TirvonaEvent, TirvonaEventType } from './webhooks';

// ------------------------------------------------------------------ types

export type ReservationStatus = 'PENDING' | 'CONFIRMED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW' | (string & {});

export interface PropertySummary {
  id: string;
  slug: string;
  name: string;
  city: string;
  state: string;
  country: string;
  currency: string;
  timezone: string;
}

export interface Property extends Omit<PropertySummary, 'id'> {
  description?: string;
  address: string;
  latitude?: number;
  longitude?: number;
  checkInTime: string;
  checkOutTime: string;
  taxPercent: number;
  amenities: string[];
  images: Record<string, unknown>[];
  roomTypes: { _id: string; name: string; description?: string; maxOccupancy: number; amenities: string[]; images: Record<string, unknown>[]; fromPrice: number }[];
}

export interface AvailabilityQuery {
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  rooms?: number;
  promoCode?: string;
}

/** Availability rows are returned as the API sends them; the fields you need to book are `roomTypeId` and `ratePlans[].ratePlanId`. */
export interface RoomAvailability {
  roomTypeId: string;
  ratePlans: { ratePlanId: string; total: number; [k: string]: unknown }[];
  [k: string]: unknown;
}

export interface CreateReservationInput {
  propertySlug: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  rooms: { roomTypeId: string; ratePlanId: string; quantity: number }[];
  guest: { firstName: string; lastName: string; email: string; phone: string; country?: string };
  specialRequests?: string;
  promoCode?: string;
  /** Your own id for this booking (unique per property). Sending it again returns the original booking instead of a duplicate. */
  externalReference?: string;
}

export interface Reservation {
  reservationCode: string;
  status: ReservationStatus;
  propertyId: string;
  propertySlug: string;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  /** `redacted: true` means the key lacks the guests:read scope: only first name and last initial are shown. */
  guest: { firstName: string; lastName: string; email: string | null; phone: string | null; redacted: boolean };
  rooms: Record<string, unknown>[];
  /** Minor units (paise for INR). */
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  amountPaid: number;
  currency: string;
  paymentStatus: string;
  source: string;
  /** The id you supplied when creating the booking, if any. */
  externalReference: string | null;
  specialRequests: string | null;
  holdExpiresAt: string | null;
  createdAt: string;
}

/** Razorpay Checkout parameters: open Checkout in the guest's browser with these, then POST /payments/verify. */
export interface CheckoutPayload {
  provider: string;
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  reservationCode: string;
  prefill?: { name: string; email: string; contact: string };
}

export interface CreateReservationResult {
  reservation: Reservation;
  payment: CheckoutPayload | null;
  /** false when this was an idempotent replay of an earlier request. */
  created: boolean;
}

export interface CancelReservationResult {
  reservation: Reservation;
  alreadyCancelled: boolean;
  refunds: { amount: number; currency: string; status: string }[];
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export interface ListReservationsQuery {
  propertySlug?: string;
  externalReference?: string;
  status?: ReservationStatus;
  checkInFrom?: string;
  checkInTo?: string;
  page?: number;
  limit?: number;
}

/** Fields of a booking you may change. Send only what changes. */
export interface UpdateReservationInput {
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  specialRequests?: string;
  guest?: { firstName?: string; lastName?: string; email?: string; phone?: string };
}

export interface ChannelConnection {
  /** Provider code, e.g. AIRBNB or the code of a configured provider. */
  channel: string;
  name: string;
  protocol: 'REST_JSON' | 'ICAL' | 'CODE';
  status: 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'EXPIRED';
  /** What the connection can do: listings, pushAvailability, pushRates, pullReservations, polling, ... */
  capabilities: string[];
  lastSyncAt: string | null;
  /** false when the last synchronisation or poll failed. Details are for the property owner. */
  healthy: boolean;
}

export interface RatePlan {
  id: string;
  roomTypeId: string;
  roomTypeName: string;
  code: string;
  name: string;
  type: string;
  /** Nightly base price in minor units (paise for INR). */
  basePrice: number;
  currency: string;
  mealPlan: string;
  status: string;
  cancellationPolicy: Record<string, unknown>;
}

export interface InventoryDay {
  date: string;
  total: number;
  sold: number;
  blocked: number;
  overbooked: number;
  available: number;
  stopSell: boolean;
  restrictions: { minimumStay: number | null; maximumStay: number | null; closed: boolean; closedToArrival: boolean; closedToDeparture: boolean };
}

export interface Inventory {
  propertySlug: string;
  from: string;
  to: string;
  roomTypes: { roomTypeId: string; roomTypeName: string; days: InventoryDay[] }[];
}

/** Restrictions applied to every night in [from, to). Send null to clear minimumStay / maximumStay. */
export interface RestrictionsInput {
  roomTypeId: string;
  from: string;
  to: string;
  minimumStay?: number | null;
  maximumStay?: number | null;
  closed?: boolean;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
}

export interface ReservationPayments {
  reservationCode: string;
  currency: string;
  total: number;
  amountPaid: number;
  amountRefunded: number;
  paymentStatus: string;
  payments: { id: string; provider: string; status: string; amount: number; amountRefunded: number; currency: string; providerPaymentId: string | null; paidAt: string | null; failureReason: string | null; createdAt: string }[];
  refunds: { id: string; paymentId: string; amount: number; currency: string; status: string; reason: string | null; processedAt: string | null; createdAt: string }[];
}

export interface TirvonaClientOptions {
  apiKey: string;
  /** e.g. https://api.example.com (no trailing path). */
  baseUrl: string;
  /** Retries for network errors, 429 and 5xx. Default 2. POST is retried only when it is safe (reservations carry an Idempotency-Key). */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Inject a fetch implementation (tests, proxies). */
  fetch?: typeof fetch;
}

// ------------------------------------------------------------------ errors

/** Any non-2xx response, or a transport failure (status 0). */
export class TirvonaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine-readable, e.g. ROOM_NOT_AVAILABLE, IDEMPOTENCY_KEY_REUSED, API_SCOPE_MISSING, RATE_LIMITED. */
    readonly code: string,
    readonly details?: unknown,
    /** Seconds from the Retry-After header (429). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TirvonaError';
  }
}

// ------------------------------------------------------------------ client

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TirvonaClient {
  private readonly base: string;
  private readonly key: string;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TirvonaClientOptions) {
    if (!opts.apiKey?.startsWith('tvk_')) throw new Error('apiKey must be a Tirvona API key (tvk_...)');
    if (!opts.baseUrl) throw new Error('baseUrl is required');
    this.key = opts.apiKey;
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.retries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  listProperties(): Promise<PropertySummary[]> {
    return this.request('GET', '/v1/properties');
  }

  getProperty(slug: string): Promise<Property> {
    return this.request('GET', `/v1/properties/${encodeURIComponent(slug)}`);
  }

  searchAvailability(slug: string, query: AvailabilityQuery): Promise<RoomAvailability[]> {
    return this.request('GET', `/v1/properties/${encodeURIComponent(slug)}/availability`, { query: { ...query } });
  }

  /**
   * Creates a reservation. An Idempotency-Key is always sent: pass your own (store it with your order so a crashed
   * process can retry safely) or let the SDK generate one. Retrying with the same key never books twice.
   */
  createReservation(input: CreateReservationInput, opts: { idempotencyKey?: string } = {}): Promise<CreateReservationResult> {
    return this.request('POST', '/v1/reservations', { body: input, idempotencyKey: opts.idempotencyKey ?? randomUUID() });
  }

  getReservation(code: string): Promise<Reservation> {
    return this.request('GET', `/v1/reservations/${encodeURIComponent(code)}`);
  }

  listReservations(query: ListReservationsQuery = {}): Promise<Page<Reservation>> {
    return this.request('GET', '/v1/reservations', { query: { ...query } });
  }

  cancelReservation(code: string, reason?: string): Promise<CancelReservationResult> {
    return this.request('POST', `/v1/reservations/${encodeURIComponent(code)}/cancel`, { body: reason ? { reason } : {} });
  }

  /** Changes dates, guest counts, contact details or notes. Needs reservations:write; channel-owned bookings are changed on their channel. */
  updateReservation(code: string, changes: UpdateReservationInput): Promise<Reservation> {
    return this.request('PATCH', `/v1/reservations/${encodeURIComponent(code)}`, { body: changes });
  }

  /** Payments and refunds of a booking. Needs payments:read. */
  getReservationPayments(code: string): Promise<ReservationPayments> {
    return this.request('GET', `/v1/reservations/${encodeURIComponent(code)}/payments`);
  }

  /** Needs rates:read. */
  /** Status and capabilities of the property's channel connections. Needs properties:read. */
  listConnections(slug: string): Promise<ChannelConnection[]> {
    return this.request('GET', `/v1/properties/${encodeURIComponent(slug)}/connections`);
  }

  listRatePlans(slug: string): Promise<RatePlan[]> {
    return this.request('GET', `/v1/properties/${encodeURIComponent(slug)}/rate-plans`);
  }

  /** Sets nightly base prices (minor units). Needs rates:write. Repeating the same call changes nothing, so it is retried safely. */
  updateRates(slug: string, updates: { ratePlanId: string; basePrice: number }[]): Promise<RatePlan[]> {
    return this.request('PUT', `/v1/properties/${encodeURIComponent(slug)}/rates`, { body: { updates } });
  }

  /** Needs inventory:read. `to` is exclusive; at most 366 nights. */
  getInventory(slug: string, query: { from: string; to: string; roomTypeId?: string }): Promise<Inventory> {
    return this.request('GET', `/v1/properties/${encodeURIComponent(slug)}/inventory`, { query: { ...query } });
  }

  /** Sets restrictions / stop-sell for a room type over a date range. Needs inventory:write. */
  setRestrictions(slug: string, input: RestrictionsInput): Promise<{ roomTypeId: string; from: string; to: string; applied: Record<string, unknown> }> {
    return this.request('PUT', `/v1/properties/${encodeURIComponent(slug)}/inventory`, { body: input });
  }

  // ------------------------------------------------------------ transport

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, opts: { query?: Record<string, unknown>; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    // A POST may be retried only if repeating it cannot do harm: reservations are idempotent by key; cancel is idempotent by nature.
    // GET, PUT and PATCH here set absolute values, so repeating them is harmless.
    const safeToRetry = method !== 'POST' || opts.idempotencyKey !== undefined || path.endsWith('/cancel');

    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let transportError: Error | undefined;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.key}`,
            Accept: 'application/json',
            'User-Agent': 'tirvona-sdk-js/0.2.0',
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        transportError = e as Error;
      }

      if (res?.ok) {
        const json = (await res.json()) as { success: boolean; data: T };
        return json.data;
      }

      const status = res?.status ?? 0;
      const retryable = transportError !== undefined || status === 429 || status >= 500;
      if (retryable && safeToRetry && attempt < this.retries) {
        const retryAfter = Number(res?.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : Math.min(250 * 2 ** attempt, 4000));
        continue;
      }
      if (!res) throw new TirvonaError(`Request failed: ${transportError?.message ?? 'network error'}`, 0, 'NETWORK_ERROR');
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
      throw new TirvonaError(body?.error?.message ?? `HTTP ${status}`, status, body?.error?.code ?? 'ERROR', body?.error?.details, Number(res.headers.get('retry-after')) || undefined);
    }
  }
}
