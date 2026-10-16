import type { Property } from '../db-types';
import type { Reservation } from '../reservation-store';
import { formatDateOnly } from './dates';

/** The reservation as the public API and webhooks present it. Part of the versioned contract: add fields, never rename or remove them within v1. */
export function apiReservationView(r: Reservation, property: Pick<Property, 'slug' | 'name'>) {
  return {
    reservationCode: r.reservationCode,
    status: r.status,
    propertyId: String(r.propertyId),
    propertySlug: property.slug,
    propertyName: property.name,
    checkIn: formatDateOnly(r.checkIn),
    checkOut: formatDateOnly(r.checkOut),
    nights: r.nights,
    adults: r.adults,
    children: r.children,
    guest: {
      firstName: r.guest.firstName,
      lastName: r.guest.lastName,
      email: r.guest.email ?? null,
      phone: r.guest.phone ?? null,
      redacted: false,
    },
    rooms: r.reservationRooms.map((l) => ({
      roomTypeId: String(l.roomTypeId),
      roomTypeName: l.roomTypeName,
      ratePlanId: l.ratePlanId ? String(l.ratePlanId) : null,
      ratePlan: l.ratePlan?.name ?? null,
      mealPlan: l.ratePlan?.mealPlan ?? null,
      cancellationPolicy: l.ratePlan?.cancellationPolicy ?? null,
      quantity: l.quantity,
      total: l.total,
    })),
    subtotal: r.subtotal,
    tax: r.tax,
    discount: r.discount,
    total: r.total,
    amountPaid: r.amountPaid,
    currency: r.currency,
    paymentStatus: r.paymentStatus,
    source: r.source,
    /** The partner software's own reference for this booking, when it supplied one. */
    externalReference: r.partnerReference ?? null,
    specialRequests: r.specialRequests ?? null,
    holdExpiresAt: r.holdExpiresAt ?? null,
    createdAt: r.createdAt,
  };
}

export type ApiReservationView = ReturnType<typeof apiReservationView>;

type WithGuest = { guest: { firstName: string; lastName: string; email: string | null; phone: string | null; redacted: boolean }; specialRequests: string | null };

/**
 * The reservation without personal contact details: first name and last initial only, no e-mail, phone or free-text
 * requests. Used for API keys that lack the guests:read scope (on bookings they did not create) and for webhook endpoints
 * that did not opt in to guest details.
 */
export function redactGuest<T extends WithGuest>(view: T): T {
  return {
    ...view,
    guest: { firstName: view.guest.firstName, lastName: view.guest.lastName ? `${view.guest.lastName.charAt(0)}.` : '', email: null, phone: null, redacted: true },
    specialRequests: null,
  };
}

/** A payment as webhooks and the API present it: no gateway metadata (UPI ids, card details), no secrets. */
export function paymentSummary(p: { id: string; provider: string; status: string; amount: number; amountRefunded: number; currency: string; providerPaymentId: string | null; paidAt: Date | null; failureReason: string | null }) {
  return {
    id: p.id,
    provider: p.provider,
    status: p.status,
    amount: p.amount,
    amountRefunded: p.amountRefunded,
    currency: p.currency,
    providerPaymentId: p.providerPaymentId,
    paidAt: p.paidAt,
    failureReason: p.failureReason,
  };
}
