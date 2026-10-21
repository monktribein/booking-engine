import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { MAX_STAY_NIGHTS } from '../constants';
import { DateInput, addDays, eachNight, formatDateOnly, toDateOnly } from '../common/dates';
import { percentOf, sum } from '../common/money';
import { NightPrice, allocateGuests, baseOccupancyOf, priceRoomNights } from '../common/pricing';
import { RestrictionRow, evaluateRestrictions } from '../common/restrictions';
import type { CancellationPolicy } from '../db-types';
import { InventoryBlockStatus, RatePlanStatus, ReservationStatus, RoomTypeStatus } from '../enums';
import { DomainValidationError, NotFoundError } from '../errors';
import { Db, InjectDb } from '../kysely';
import { d } from '../sql';
import { loadRateRules } from './rate-engine';

type Id = string;

export interface AvailabilityQuery {
  propertyId: Id;
  checkIn: DateInput;
  checkOut: DateInput;
  adults: number;
  children?: number;
  rooms?: number;
}

export interface AvailableRoomType {
  roomTypeId: Id;
  name: string;
  maxOccupancy: number;
  /** Rooms sellable on every night of the stay: min(available) across nights. */
  availableUnits: number;
  bookable: boolean;
  reasons: string[];
  ratePlans: Array<{
    ratePlanId: Id;
    code: string;
    name: string;
    mealPlan: string;
    cancellationPolicy: CancellationPolicy;
    /** Average nightly price per room including any extra-guest charge: subtotal / (nights x rooms), rounded. */
    nightly: number;
    /** Per-night price of the first room (rate + extra-guest charge), exactly as it will be frozen on the booking. */
    nightlyRates: NightPrice[];
    /** Extra-guest charges included in `subtotal`, all rooms and nights. */
    extraGuestCharges: number;
    subtotal: number;
    tax: number;
    total: number;
  }>;
}

@Injectable()
export class AvailabilityService {
  constructor(@InjectDb() private readonly db: Db) {}

  /**
   * Availability search for the booking engines: group the nights per room type from the inventory index
   * (property, room type, date), keep types with every night materialised (missing rows mean the dates are beyond the
   * sellable horizon), then load the room types, the restriction rows for [checkIn, checkOut] and the active rate plans.
   * Restriction logic and pricing run in application code.
   *
   * This is a read, not a reservation. The booking transaction re-checks everything.
   */
  async search(q: AvailabilityQuery): Promise<AvailableRoomType[]> {
    const checkIn = toDateOnly(q.checkIn);
    const checkOut = toDateOnly(q.checkOut);
    const nights = eachNight(checkIn, checkOut).length;
    if (nights < 1 || nights > MAX_STAY_NIGHTS) throw new DomainValidationError(`Stay must be 1..${MAX_STAY_NIGHTS} nights`);
    const rooms = q.rooms ?? 1;
    const guests = q.adults + (q.children ?? 0);

    const property = await this.db.selectFrom('properties').select(['id', 'taxPercent']).where('id', '=', q.propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', q.propertyId);

    const grouped = await this.db
      .selectFrom('inventory')
      .select((eb) => [
        'roomTypeId',
        eb.fn.countAll<number>().as('nights'),
        eb.fn.min('available').as('minAvailable'),
        sql<boolean>`bool_or(stop_sell)`.as('anyStopSell'),
      ])
      .where('propertyId', '=', property.id)
      .where('date', '>=', d(checkIn))
      .where('date', '<', d(checkOut))
      .groupBy('roomTypeId')
      .having((eb) => eb.fn.countAll(), '=', nights)
      .execute();
    if (!grouped.length) return [];
    const ids = grouped.map((g) => g.roomTypeId);

    const [roomTypes, restrictions, plans] = await Promise.all([
      this.db.selectFrom('roomTypes').select(['id', 'name', 'maxOccupancy', 'sortOrder', 'basePrice', 'baseOccupancy', 'extraAdultCharge', 'extraChildCharge']).where('id', 'in', ids).where('status', '=', RoomTypeStatus.ACTIVE).execute(),
      this.db
        .selectFrom('restrictions')
        .select(['roomTypeId', 'date', 'minimumStay', 'maximumStay', 'closed', 'closedToArrival', 'closedToDeparture', 'stopSell'])
        .where('propertyId', '=', property.id)
        .where('roomTypeId', 'in', ids)
        .where('date', '>=', d(checkIn))
        .where('date', '<=', d(checkOut))
        .execute(),
      this.db
        .selectFrom('ratePlans')
        .select(['id', 'roomTypeId', 'code', 'name', 'basePrice', 'mealPlan', 'cancellationPolicy'])
        .where('propertyId', '=', property.id)
        .where('roomTypeId', 'in', ids)
        .where('status', '=', RatePlanStatus.ACTIVE)
        .orderBy('basePrice')
        .execute(),
    ]);

    const rules = await loadRateRules(this.db, property.id, ids, checkIn, checkOut);
    const nightDates = eachNight(checkIn, checkOut);
    const groupById = new Map(grouped.map((g) => [g.roomTypeId, g]));
    return roomTypes
      .sort((a, b) => a.sortOrder - b.sortOrder || a.basePrice - b.basePrice)
      .map((rt) => {
        const g = groupById.get(rt.id)!;
        const minAvailable = Number(g.minAvailable);
        const reasons = evaluateRestrictions(restrictions.filter((r) => r.roomTypeId === rt.id), checkIn, checkOut);
        if (g.anyStopSell && !reasons.some((r) => r.startsWith('closed for sale'))) reasons.push('stop sell');
        if (minAvailable < rooms) reasons.push(`only ${Math.max(0, minAvailable)} room(s) left`);
        if (guests > rt.maxOccupancy * rooms) reasons.push(`sleeps at most ${rt.maxOccupancy} per room`);
        const ratePlans = plans.filter((p) => p.roomTypeId === rt.id);
        if (!ratePlans.length) reasons.push('no active rate plan');

        return {
          roomTypeId: rt.id,
          name: rt.name,
          maxOccupancy: rt.maxOccupancy,
          availableUnits: Math.max(0, minAvailable),
          bookable: reasons.length === 0,
          reasons,
          ratePlans: ratePlans.map((rp) => {
            // The same calculation the booking transaction runs: rules per night, extra guests per room, tax per room.
            const terms = { baseOccupancy: rt.baseOccupancy, maxOccupancy: rt.maxOccupancy, extraAdultCharge: rt.extraAdultCharge, extraChildCharge: rt.extraChildCharge };
            const party = allocateGuests(Array.from({ length: rooms }, () => ({ baseOccupancy: baseOccupancyOf(terms), maxOccupancy: rt.maxOccupancy })), q.adults, q.children ?? 0);
            const perRoom = party.map((guests) =>
              priceRoomNights({ nights: nightDates, basePrice: rp.basePrice, ratePlanId: rp.id, rules: rules.filter((r) => r.roomTypeId === rt.id), guests, terms }),
            );
            const roomSubtotals = perRoom.map((nightsOfRoom) => sum(nightsOfRoom.map((n) => n.amount)));
            const subtotal = sum(roomSubtotals);
            const tax = sum(roomSubtotals.map((x) => percentOf(x, property.taxPercent)));
            return {
              ratePlanId: rp.id,
              code: rp.code,
              name: rp.name,
              mealPlan: rp.mealPlan,
              cancellationPolicy: rp.cancellationPolicy,
              nightly: Math.round(subtotal / (nights * rooms)),
              nightlyRates: perRoom[0],
              extraGuestCharges: sum(perRoom.flatMap((r) => r.map((n) => n.extra))),
              subtotal,
              tax,
              total: subtotal + tax,
            };
          }),
        };
      });
  }
}

// ==================================================================== calendar

export interface CalendarCell {
  date: string;
  initialized: boolean;
  total: number;
  sold: number;
  blocked: number;
  available: number;
  overbooked: number;
  stopSell: boolean;
  restriction: RestrictionRow | null;
}

@Injectable()
export class CalendarService {
  constructor(@InjectDb() private readonly db: Db) {}

  /**
   * PMS calendar / tape chart for [from, to): a room-type × date grid of counts and restrictions, plus the reservations
   * and blocks that overlap the window so the UI can draw bars per physical room. Five indexed queries run in parallel.
   */
  async getCalendar(propertyId: Id, fromInput: DateInput, toInput: DateInput) {
    const from = toDateOnly(fromInput);
    const to = toDateOnly(toInput);
    const days = eachNight(from, to);
    if (!days.length || days.length > 366) throw new DomainValidationError('Calendar window must be 1..366 days');

    const [roomTypes, inventory, restrictions, reservations, blocks] = await Promise.all([
      this.db
        .selectFrom('roomTypes')
        .select(['id', 'name', 'totalRooms', 'sortOrder'])
        .where('propertyId', '=', propertyId)
        .where('status', '<>', RoomTypeStatus.ARCHIVED)
        .orderBy('sortOrder')
        .orderBy('name')
        .execute(),
      this.db
        .selectFrom('inventory')
        .select(['roomTypeId', 'date', 'total', 'sold', 'blocked', 'available', 'overbooked', 'stopSell'])
        .where('propertyId', '=', propertyId)
        .where('date', '>=', d(from))
        .where('date', '<', d(to))
        .execute(),
      this.db
        .selectFrom('restrictions')
        .select(['roomTypeId', 'date', 'minimumStay', 'maximumStay', 'closed', 'closedToArrival', 'closedToDeparture', 'stopSell'])
        .where('propertyId', '=', propertyId)
        .where('date', '>=', d(from))
        .where('date', '<', d(to))
        .execute(),
      // Overlap: check_in < to AND check_out > from. The lower bound on check_in (stays are <= MAX_STAY_NIGHTS) keeps the
      // (property, check_in, check_out) index scan bounded.
      this.db
        .selectFrom('reservations as r')
        .select((eb) => [
          'r.id',
          'r.reservationCode',
          'r.status',
          'r.source',
          'r.guest',
          'r.checkIn',
          'r.checkOut',
          'r.overbooked',
          'r.paymentStatus',
          sql<unknown[]>`coalesce((select json_agg(json_build_object('id', rr.id, 'roomTypeId', rr.room_type_id, 'roomId', rr.room_id, 'roomNumber', rr.room_number) order by rr.position)
                                   from reservation_rooms rr where rr.reservation_id = r.id), '[]'::json)`.as('reservationRooms'),
        ])
        .where('r.propertyId', '=', propertyId)
        .where('r.checkIn', '<', d(to))
        .where('r.checkIn', '>=', d(addDays(from, -MAX_STAY_NIGHTS)))
        .where('r.checkOut', '>', d(from))
        .where('r.status', 'in', [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN, ReservationStatus.CHECKED_OUT])
        .orderBy('r.checkIn')
        .execute(),
      this.db
        .selectFrom('inventoryBlocks')
        .select(['id', 'roomTypeId', 'roomId', 'startDate', 'endDate', 'quantity', 'reason'])
        .where('propertyId', '=', propertyId)
        .where('status', '=', InventoryBlockStatus.ACTIVE)
        .where('startDate', '<', d(to))
        .where('endDate', '>', d(from))
        .execute(),
    ]);

    const key = (rt: string, day: Date) => `${rt}|${day.getTime()}`;
    const invByKey = new Map(inventory.map((i) => [key(i.roomTypeId, i.date), i]));
    const resByKey = new Map(restrictions.map((r) => [key(r.roomTypeId, r.date), r]));

    return {
      from: formatDateOnly(from),
      to: formatDateOnly(to),
      roomTypes: roomTypes.map((rt) => ({
        roomTypeId: rt.id,
        name: rt.name,
        days: days.map<CalendarCell>((day) => {
          const inv = invByKey.get(key(rt.id, day));
          const r = resByKey.get(key(rt.id, day));
          return {
            date: formatDateOnly(day),
            initialized: !!inv,
            total: inv?.total ?? rt.totalRooms,
            sold: inv?.sold ?? 0,
            blocked: inv?.blocked ?? 0,
            available: inv?.available ?? rt.totalRooms,
            overbooked: inv?.overbooked ?? 0,
            stopSell: inv?.stopSell ?? false,
            restriction: r
              ? {
                  date: r.date,
                  minimumStay: r.minimumStay,
                  maximumStay: r.maximumStay,
                  closed: r.closed,
                  closedToArrival: r.closedToArrival,
                  closedToDeparture: r.closedToDeparture,
                  stopSell: r.stopSell,
                }
              : null,
          };
        }),
      })),
      reservations,
      blocks,
    };
  }
}
