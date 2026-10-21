/**
 * Translates between the NestJS API contract (see /docs/openapi.json) and the view-model types the UI uses.
 *
 * Rules:
 * - Pure functions, no I/O and no defaults that invent business data. A field the backend does not provide
 *   is left undefined so the UI can show "not available" instead of a made-up number.
 * - Dates stay as the backend sends them, except where a type is documented as date-only (YYYY-MM-DD).
 */
import {
  ChannelConnectionStatus,
  ChannelPaymentVisibility,
  ChannelKind,
  ChannelListing,
  ChannelStatusInfo,
  Guest,
  InventoryBlock,
  InventoryCalendarResult,
  OccupancyReport,
  PaginatedResult,
  PhysicalRoom,
  Promotion,
  PublicAvailabilityItem,
  PublicBookingResult,
  PublicReservationView,
  PublicPropertyData,
  RatePlan,
  Reservation,
  ReservationRoom,
  RevenueReport,
  RoomType,
} from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export const dateOnly = (iso?: string | null): string => (iso ? iso.slice(0, 10) : '');

export function mapPage<T, U>(raw: { items: T[]; page: number; limit: number; total: number }, fn: (x: T) => U): PaginatedResult<U> {
  return {
    items: raw.items.map(fn),
    page: raw.page,
    limit: raw.limit,
    total: raw.total,
    totalPages: Math.max(1, Math.ceil(raw.total / Math.max(1, raw.limit))),
  };
}

// ---------------------------------------------------------------- rooms & rates
export function mapRoom(r: Raw): PhysicalRoom {
  const { notes, ...rest } = r;
  return { ...rest, cleaningNotes: notes };
}

export function mapRoomType(r: Raw): RoomType {
  return r as RoomType;
}

export function mapRatePlan(r: Raw): RatePlan {
  return { ...r, isActive: r.status === 'ACTIVE' };
}

/** UI rate plan -> backend create/update body (backend rejects unknown fields). */
export function ratePlanBody(p: Partial<RatePlan>, mode: 'create' | 'update'): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: p.name,
    type: p.type,
    basePrice: p.basePrice,
    mealPlan: p.mealPlan,
    cancellationPolicy: p.cancellationPolicy,
  };
  if (mode === 'create') {
    body.roomTypeId = p.roomTypeId;
    body.code = p.code;
  } else if (p.isActive !== undefined) {
    body.status = p.isActive ? 'ACTIVE' : 'INACTIVE';
  }
  return stripUndefined(body);
}

export function mapPromotion(p: Raw): Promotion {
  return {
    _id: p._id,
    propertyId: p.propertyId,
    code: p.code,
    description: p.name,
    discountPercent: p.type === 'PERCENTAGE' ? p.value : 0,
    validFrom: dateOnly(p.validFrom),
    validTo: dateOnly(p.validTo),
    isActive: p.active,
    maxRedemptions: p.maxRedemptions ?? null,
    maxPerGuest: p.maxPerGuest ?? null,
    minBookingValue: p.minBookingValue ?? 0,
    redeemed: p.redeemed,
  };
}

export function promotionBody(p: Partial<Promotion>): Record<string, unknown> {
  return stripUndefined({
    code: p.code,
    name: p.description || p.code,
    type: 'PERCENTAGE',
    value: p.discountPercent,
    validFrom: p.validFrom,
    validTo: p.validTo,
    active: p.isActive,
    maxRedemptions: p.maxRedemptions ?? undefined,
    maxPerGuest: p.maxPerGuest ?? undefined,
    minBookingValue: p.minBookingValue || undefined,
  });
}

// ---------------------------------------------------------------- reservations
/**
 * What the backend knows about the money of a channel booking. A null column is left undefined ("not reported"); nothing is
 * defaulted, and the result is undefined when the backend reported nothing at all.
 */
export function mapChannelPayment(r: Raw): ChannelPaymentVisibility | undefined {
  const pick = <T,>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);
  const out: ChannelPaymentVisibility = {
    collectionModel: pick(r.collectionModel),
    collectionSource: pick(r.collectionSource),
    providerPaymentStatusRaw: pick(r.providerPaymentStatusRaw),
    providerPaymentStatus: pick(r.providerPaymentStatus),
    payoutStatusRaw: pick(r.payoutStatusRaw),
    payoutStatus: pick(r.payoutStatus),
    payoutDate: pick(r.payoutDate),
    commissionAmount: pick(r.commissionAmount),
    netAmount: pick(r.netAmount),
    updatedAt: pick(r.paymentInfoUpdatedAt),
  };
  return Object.values(out).some((v) => v !== undefined) ? stripUndefined({ ...out }) : undefined;
}

export function mapReservation(r: Raw): Reservation {
  const rooms: ReservationRoom[] = (r.reservationRooms ?? []).map((rr: Raw) => ({
    _id: rr._id,
    roomTypeId: rr.roomTypeId,
    roomTypeName: rr.roomTypeName,
    ratePlanId: rr.ratePlanId,
    ratePlanName: rr.ratePlan?.name,
    roomId: rr.roomId ?? null,
    roomNumber: rr.roomNumber ?? undefined,
    quantity: rr.quantity,
    nightlyPrice: rr.nightlyRates?.length ? Math.round(rr.subtotal / rr.quantity / rr.nightlyRates.length) : 0,
    nights: r.nights,
    total: rr.total,
  }));
  return {
    _id: r._id,
    propertyId: r.propertyId,
    code: r.reservationCode,
    source: r.source,
    status: r.status,
    paymentStatus: r.paymentStatus,
    guest: {
      _id: r.guestId,
      propertyId: r.propertyId,
      firstName: r.guest?.firstName ?? '',
      lastName: r.guest?.lastName ?? '',
      email: r.guest?.email,
      phone: r.guest?.phone,
      country: r.guest?.country,
    },
    checkIn: dateOnly(r.checkIn),
    checkOut: dateOnly(r.checkOut),
    adults: r.adults,
    children: r.children,
    rooms,
    subtotal: r.subtotal,
    taxAmount: r.tax,
    discountAmount: r.discount,
    total: r.total,
    currency: r.currency,
    amountPaid: r.amountPaid,
    amountRefunded: r.amountRefunded,
    channelPayment: mapChannelPayment(r),
    holdExpiresAt: r.holdExpiresAt ?? undefined,
    channelReservationId: r.externalReservationId,
    specialRequests: r.specialRequests,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The public booking view is a reduced projection (no ids, no guest); it is kept as its own type, never faked into a Reservation. */
export function mapPublicReservationView(v: Raw): PublicReservationView {
  return {
    reservationCode: v.reservationCode,
    status: v.status,
    propertyName: v.propertyName,
    checkIn: dateOnly(v.checkIn),
    checkOut: dateOnly(v.checkOut),
    nights: v.nights,
    adults: v.adults,
    children: v.children,
    rooms: (v.rooms ?? []).map((rr: Raw) => ({
      roomTypeName: rr.roomTypeName,
      ratePlan: rr.ratePlan,
      mealPlan: rr.mealPlan,
      cancellationDescription: rr.cancellationPolicy?.description,
      total: rr.total,
    })),
    subtotal: v.subtotal,
    tax: v.tax,
    discount: v.discount,
    total: v.total,
    currency: v.currency,
    paymentStatus: v.paymentStatus,
    holdExpiresAt: v.holdExpiresAt ?? undefined,
    cancellation: v.cancellation ?? undefined,
  };
}

export function mapGuest(g: Raw): Guest {
  return g as Guest;
}

// ---------------------------------------------------------------- inventory
export function mapCalendar(propertyId: string, raw: Raw): InventoryCalendarResult {
  return {
    propertyId,
    from: dateOnly(raw.from),
    to: dateOnly(raw.to),
    roomTypes: raw.roomTypes.map((rt: Raw) => ({
      roomTypeId: rt.roomTypeId,
      roomTypeName: rt.name,
      days: rt.days.map((d: Raw) => ({
        date: dateOnly(d.date),
        total: d.total,
        sold: d.sold,
        blocked: d.blocked,
        available: d.available,
        stopSell: d.stopSell || !!d.restriction?.stopSell,
        closedToArrival: !!d.restriction?.closedToArrival,
        closedToDeparture: !!d.restriction?.closedToDeparture,
        minimumStay: d.restriction?.minimumStay ?? 1,
        maximumStay: d.restriction?.maximumStay ?? undefined,
      })),
    })),
    blocks: (raw.blocks ?? []).map(mapBlock),
    reservations: (raw.reservations ?? []).map((r: Raw) => ({
      reservationId: r._id,
      code: r.reservationCode,
      guestName: [r.guest?.firstName, r.guest?.lastName].filter(Boolean).join(' '),
      channel: r.source,
      rooms: (r.reservationRooms ?? []).map((rr: Raw) => ({
        roomTypeId: rr.roomTypeId,
        roomId: rr.roomId ?? null,
        roomNumber: rr.roomNumber ?? undefined,
      })),
      checkIn: dateOnly(r.checkIn),
      checkOut: dateOnly(r.checkOut),
      status: r.status,
    })),
  };
}

export function mapBlock(b: Raw): InventoryBlock {
  return {
    ...b,
    roomId: b.roomId ?? null,
    startDate: dateOnly(b.startDate),
    endDate: dateOnly(b.endDate),
  };
}

// ---------------------------------------------------------------- channels
export function mapChannel(c: Raw): ChannelStatusInfo {
  const status = c.status === 'INTERNAL' ? ChannelConnectionStatus.CONNECTED : c.status;
  return {
    channel: c.channel,
    name: c.displayName,
    kind: c.channel === 'TIRVONA' ? ChannelKind.MARKETPLACE : c.internal ? ChannelKind.DIRECT : ChannelKind.OTA,
    status,
    internal: c.internal,
    configured: c.configured === true,
    available: c.available,
    connectedAt: c.connectedAt,
    lastSyncAt: c.lastSyncAt,
    lastError: c.lastError,
    listingsCount: c.listings,
    mappedCount: c.mappings,
  };
}

export function mapListing(propertyId: string, channel: string, l: Raw): ChannelListing {
  return {
    _id: l._id,
    propertyId,
    channel: (l.channel ?? channel) as ChannelListing['channel'],
    externalListingId: l.externalListingId,
    name: l.name,
    status: l.status,
    externalRooms: l.externalRooms,
    externalRatePlans: l.externalRatePlans,
    roomMappings: l.roomMappings,
  };
}

// ---------------------------------------------------------------- reports
export function mapOccupancy(rows: Raw[]): OccupancyReport[] {
  return rows.map((r) => ({
    date: r.date,
    totalRooms: r.total,
    soldRooms: r.sold,
    blockedRooms: r.blocked,
    availableRooms: Math.max(0, r.total - r.sold - r.blocked),
    occupancyPercent: r.occupancyPct,
  }));
}

export function mapRevenue(raw: Raw, from?: string, to?: string): RevenueReport {
  const totalNights = raw.bySource.reduce((a: number, r: Raw) => a + r.roomNights, 0);
  return {
    period: from && to ? `${from} to ${to}` : 'Selected period',
    currency: raw.currency,
    totalRevenue: raw.totalRevenue,
    adr: totalNights ? Math.round(raw.totalRevenue / totalNights) : 0,
    revPar: raw.revPar,
    bySource: raw.bySource.map((r: Raw) => ({
      source: r.source,
      revenue: r.revenue,
      bookings: r.bookings,
      roomNights: r.roomNights,
      percentage: raw.totalRevenue ? Math.round((r.revenue / raw.totalRevenue) * 100) : 0,
    })),
  };
}

// ---------------------------------------------------------------- public booking engine
export function mapPublicProperty(p: Raw): PublicPropertyData {
  return {
    ...p,
    roomTypes: p.roomTypes.map((rt: Raw) => ({
      ...rt,
      images: rt.images ?? [],
      startingFromPrice: rt.fromPrice,
      currency: p.currency,
    })),
  };
}

export function mapAvailability(items: Raw[], property?: Pick<PublicPropertyData, 'roomTypes'>): PublicAvailabilityItem[] {
  return items.map((i) => {
    const rt = property?.roomTypes.find((x) => x._id === i.roomTypeId);
    return {
      roomTypeId: i.roomTypeId,
      roomTypeName: i.name,
      description: rt?.description ?? '',
      maxOccupancy: i.maxOccupancy,
      amenities: rt?.amenities ?? [],
      images: rt?.images ?? [],
      availableRooms: i.availableUnits,
      bookable: i.bookable,
      reasons: i.reasons ?? [],
      ratePlans: i.ratePlans.map((rp: Raw) => ({
        ratePlanId: rp.ratePlanId,
        name: rp.name,
        mealPlan: rp.mealPlan,
        nightlyPrice: rp.nightly,
        totalPrice: rp.total,
        subtotal: rp.subtotal,
        discountAmount: rp.discount ?? 0,
        taxAmount: rp.tax,
        extraGuestCharges: rp.extraGuestCharges ?? 0,
        promoProblem: rp.promoProblem,
        cancellationDescription: rp.cancellationPolicy?.description ?? '',
      })),
    };
  });
}

export function mapPublicBookingResult(raw: Raw): PublicBookingResult {
  return { reservation: mapPublicReservationView(raw.reservation), payment: raw.payment ?? null, created: raw.created };
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
