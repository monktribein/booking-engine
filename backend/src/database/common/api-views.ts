import type { Property } from '../schemas/property.schema';
import type { Reservation } from '../schemas/reservation.schema';
import { formatDateOnly } from './dates';

/** The reservation as the public API and webhooks present it. Part of the versioned contract: add fields, never rename or remove them within v1. */
export function apiReservationView(r: Reservation, property: Pick<Property, 'slug' | 'name'> & { _id?: unknown }) {
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
    specialRequests: r.specialRequests ?? null,
    holdExpiresAt: r.holdExpiresAt ?? null,
    createdAt: r.createdAt,
  };
}

export type ApiReservationView = ReturnType<typeof apiReservationView>;
