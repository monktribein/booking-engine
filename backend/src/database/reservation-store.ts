import type { Insertable, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { NightlyRate, RatePlanSnapshot, ReservationsTable } from './db-types';
import { Db, j } from './kysely';

/**
 * A reservation is an aggregate: one `reservations` row plus its `reservation_rooms` lines. Services work with the
 * assembled object (`reservationRooms` inside the reservation) and these functions read and write the two tables
 * together.
 */
export interface ReservationRoom {
  id: string;
  roomTypeId: string;
  roomTypeName: string;
  /** Physical room; null until assigned. Must be null when quantity > 1. */
  roomId: string | null;
  roomNumber: string | null;
  quantity: number;
  /** Null for OTA bookings whose external rate plan is not mapped. */
  ratePlanId: string | null;
  ratePlan: RatePlanSnapshot | null;
  nightlyRates: NightlyRate[];
  /** sum(nightlyRates.amount) * quantity */
  subtotal: number;
  tax: number;
  /** subtotal + tax */
  total: number;
}

export type ReservationRow = Selectable<ReservationsTable>;
export interface Reservation extends ReservationRow {
  reservationRooms: ReservationRoom[];
}

export interface ReservationFilter {
  id?: string;
  propertyId?: string;
  reservationCode?: string;
  source?: string;
  externalReservationId?: string;
  idempotencyKey?: string;
}

/** Loads the lines of many reservations in one query and assembles the aggregates (input order is kept). */
export async function attachRooms(q: Db, rows: ReservationRow[]): Promise<Reservation[]> {
  if (!rows.length) return [];
  const lines = await q
    .selectFrom('reservationRooms')
    .selectAll()
    .where('reservationId', 'in', rows.map((r) => r.id))
    .orderBy('position')
    .execute();
  const byReservation = new Map<string, ReservationRoom[]>();
  for (const l of lines) {
    const list = byReservation.get(l.reservationId) ?? [];
    list.push({
      id: l.id,
      roomTypeId: l.roomTypeId,
      roomTypeName: l.roomTypeName,
      roomId: l.roomId,
      roomNumber: l.roomNumber,
      quantity: l.quantity,
      ratePlanId: l.ratePlanId,
      ratePlan: l.ratePlan,
      nightlyRates: l.nightlyRates,
      subtotal: l.subtotal,
      tax: l.tax,
      total: l.total,
    });
    byReservation.set(l.reservationId, list);
  }
  return rows.map((r) => ({ ...r, reservationRooms: byReservation.get(r.id) ?? [] }));
}

/**
 * Finds one reservation by id, code, (source, external id) or (property, idempotency key). With `forUpdate` the
 * reservation row is locked for the rest of the transaction, so concurrent modifications queue instead of racing.
 */
export async function findReservation(q: Db, f: ReservationFilter, opts: { forUpdate?: boolean } = {}): Promise<Reservation | null> {
  let query = q.selectFrom('reservations').selectAll();
  if (f.id) query = query.where('id', '=', f.id);
  if (f.propertyId) query = query.where('propertyId', '=', f.propertyId);
  if (f.reservationCode) query = query.where('reservationCode', '=', f.reservationCode.toUpperCase());
  if (f.source) query = query.where('source', '=', f.source);
  if (f.externalReservationId) query = query.where('externalReservationId', '=', f.externalReservationId);
  if (f.idempotencyKey) query = query.where('idempotencyKey', '=', f.idempotencyKey);
  if (opts.forUpdate) query = query.forUpdate();
  const row = await query.limit(1).executeTakeFirst();
  if (!row) return null;
  return (await attachRooms(q, [row]))[0];
}

type NewRoomLine = Omit<ReservationRoom, 'id'>;

/** Inserts the reservation row and its lines. The caller's transaction makes the pair atomic. */
export async function insertReservation(q: Db, row: Insertable<ReservationsTable>, lines: NewRoomLine[]): Promise<Reservation> {
  const inserted = await q.insertInto('reservations').values(row).returningAll().executeTakeFirstOrThrow();
  await q
    .insertInto('reservationRooms')
    .values(
      lines.map((l, position) => ({
        reservationId: inserted.id,
        position,
        roomTypeId: l.roomTypeId,
        roomTypeName: l.roomTypeName,
        roomId: l.roomId,
        roomNumber: l.roomNumber,
        quantity: l.quantity,
        ratePlanId: l.ratePlanId,
        ratePlan: l.ratePlan ? j(l.ratePlan) : null,
        nightlyRates: j(l.nightlyRates),
        subtotal: l.subtotal,
        tax: l.tax,
        total: l.total,
      })),
    )
    .execute();
  return (await attachRooms(q, [inserted]))[0];
}

/**
 * Persists every mutable field of an assembled reservation (and its lines) after a service changed it in memory.
 * Identity columns (id, property, code, source, external ids, created_at) are never written.
 */
export async function saveReservation(q: Db, r: Reservation): Promise<void> {
  await q
    .updateTable('reservations')
    .set({
      status: r.status,
      guest: j(r.guest),
      checkIn: r.checkIn.toISOString().slice(0, 10),
      checkOut: r.checkOut.toISOString().slice(0, 10),
      nights: r.nights,
      adults: r.adults,
      children: r.children,
      specialRequests: r.specialRequests,
      subtotal: r.subtotal,
      tax: r.tax,
      discount: r.discount,
      total: r.total,
      amountPaid: r.amountPaid,
      amountRefunded: r.amountRefunded,
      paymentStatus: r.paymentStatus,
      holdExpiresAt: r.holdExpiresAt,
      overbooked: r.overbooked,
      inventoryReleasedFrom: r.inventoryReleasedFrom ? r.inventoryReleasedFrom.toISOString().slice(0, 10) : null,
      checkedInAt: r.checkedInAt,
      checkedOutAt: r.checkedOutAt,
      statusHistory: j(r.statusHistory),
      cancelledAt: r.cancelledAt,
      cancellationReason: r.cancellationReason,
    })
    .where('id', '=', r.id)
    .execute();
  for (const l of r.reservationRooms) {
    await q
      .updateTable('reservationRooms')
      .set({ roomId: l.roomId, roomNumber: l.roomNumber, nightlyRates: j(l.nightlyRates), subtotal: l.subtotal, tax: l.tax, total: l.total })
      .where('id', '=', l.id)
      .execute();
  }
}

/** `status_history || [entry]` as an SQL expression, for atomic appends. */
export const appendStatus = (entry: { status: string; at: Date; by: string | null; reason?: string }) =>
  sql`status_history || ${j([{ ...entry, at: entry.at.toISOString() }])}::jsonb`;
