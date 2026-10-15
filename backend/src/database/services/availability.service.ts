import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, PipelineStage, Types } from 'mongoose';
import { COLLECTION, MAX_STAY_NIGHTS } from '../constants';
import { DateInput, eachNight, formatDateOnly, toDateOnly } from '../common/dates';
import { percentOf } from '../common/money';
import { RestrictionRow, evaluateRestrictions } from '../common/restrictions';
import { InventoryBlockStatus, RatePlanStatus, ReservationStatus, RoomTypeStatus } from '../enums';
import { DomainValidationError, NotFoundError } from '../errors';
import { Models, getModels } from '../models';
import type { CancellationPolicy } from '../schemas/property.schema';

type Id = Types.ObjectId;

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
    nightly: number;
    subtotal: number;
    tax: number;
    total: number;
  }>;
}

@Injectable()
export class AvailabilityService {
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

  /**
   * Availability search for the booking engines. One aggregation over the
   * inventory index {propertyId, roomTypeId, date}:
   *   group nights per room type → keep types with every night materialised →
   *   join room type, the restriction rows for [checkIn, checkOut], active rate plans.
   * Restriction logic and pricing then run in application code.
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

    const property = await this.m.Property.findById(q.propertyId, { taxPercent: 1, currency: 1 }).lean();
    if (!property) throw new NotFoundError('Property', q.propertyId);

    const pipeline: PipelineStage[] = [
      { $match: { propertyId: property._id, date: { $gte: checkIn, $lt: checkOut } } },
      {
        $group: {
          _id: '$roomTypeId',
          nights: { $sum: 1 },
          minAvailable: { $min: '$available' },
          anyStopSell: { $max: '$stopSell' },
        },
      },
      // Missing rows mean the dates are beyond the sellable horizon.
      { $match: { nights } },
      { $lookup: { from: COLLECTION.roomTypes, localField: '_id', foreignField: '_id', as: 'roomType' } },
      { $unwind: '$roomType' },
      { $match: { 'roomType.status': RoomTypeStatus.ACTIVE } },
      {
        $lookup: {
          from: COLLECTION.restrictions,
          localField: '_id',
          foreignField: 'roomTypeId',
          // propertyId + roomTypeId (from foreignField) + date range → uses the unique restrictions index.
          pipeline: [
            { $match: { propertyId: property._id, date: { $gte: checkIn, $lte: checkOut } } },
            { $project: { _id: 0, propertyId: 0, roomTypeId: 0, createdAt: 0, updatedAt: 0, __v: 0 } },
          ],
          as: 'restrictions',
        },
      },
      {
        $lookup: {
          from: COLLECTION.ratePlans,
          localField: '_id',
          foreignField: 'roomTypeId',
          pipeline: [
            { $match: { propertyId: property._id, status: RatePlanStatus.ACTIVE } },
            { $project: { code: 1, name: 1, basePrice: 1, mealPlan: 1, cancellationPolicy: 1 } },
            { $sort: { basePrice: 1 } },
          ],
          as: 'ratePlans',
        },
      },
      { $sort: { 'roomType.sortOrder': 1, 'roomType.basePrice': 1 } },
    ];

    const rows = await this.m.Inventory.aggregate<{
      _id: Id;
      minAvailable: number;
      anyStopSell: boolean;
      roomType: { name: string; maxOccupancy: number };
      restrictions: RestrictionRow[];
      ratePlans: { _id: Id; code: string; name: string; basePrice: number; mealPlan: string; cancellationPolicy: CancellationPolicy }[];
    }>(pipeline);

    return rows.map((row) => {
      const reasons = evaluateRestrictions(row.restrictions, checkIn, checkOut);
      if (row.anyStopSell && !reasons.some((r) => r.startsWith('closed for sale'))) reasons.push('stop sell');
      if (row.minAvailable < rooms) reasons.push(`only ${Math.max(0, row.minAvailable)} room(s) left`);
      if (guests > row.roomType.maxOccupancy * rooms) reasons.push(`sleeps at most ${row.roomType.maxOccupancy} per room`);
      if (!row.ratePlans.length) reasons.push('no active rate plan');

      return {
        roomTypeId: row._id,
        name: row.roomType.name,
        maxOccupancy: row.roomType.maxOccupancy,
        availableUnits: Math.max(0, row.minAvailable),
        bookable: reasons.length === 0,
        reasons,
        ratePlans: row.ratePlans.map((rp) => {
          const subtotal = rp.basePrice * nights * rooms;
          const tax = percentOf(rp.basePrice * nights, property.taxPercent) * rooms;
          return {
            ratePlanId: rp._id,
            code: rp.code,
            name: rp.name,
            mealPlan: rp.mealPlan,
            cancellationPolicy: rp.cancellationPolicy,
            nightly: rp.basePrice,
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
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

  /**
   * PMS calendar / tape chart for [from, to): a room-type × date grid of counts
   * and restrictions, plus the reservations and blocks that overlap the window
   * so the UI can draw bars per physical room. Five indexed queries run in parallel.
   */
  async getCalendar(propertyId: Id, fromInput: DateInput, toInput: DateInput) {
    const from = toDateOnly(fromInput);
    const to = toDateOnly(toInput);
    const days = eachNight(from, to);
    if (!days.length || days.length > 366) throw new DomainValidationError('Calendar window must be 1..366 days');

    const [roomTypes, inventory, restrictions, reservations, blocks] = await Promise.all([
      this.m.RoomType.find({ propertyId, status: { $ne: RoomTypeStatus.ARCHIVED } }, { name: 1, totalRooms: 1, sortOrder: 1 })
        .sort({ sortOrder: 1, name: 1 })
        .lean(),
      this.m.Inventory.find(
        { propertyId, date: { $gte: from, $lt: to } },
        { roomTypeId: 1, date: 1, total: 1, sold: 1, blocked: 1, available: 1, overbooked: 1, stopSell: 1 },
      ).lean(),
      this.m.Restriction.find({ propertyId, date: { $gte: from, $lt: to } }).lean(),
      this.m.Reservation.find(
        {
          propertyId,
          // Overlap: checkIn < to AND checkOut > from. The lower bound on checkIn
          // (stays are <= MAX_STAY_NIGHTS) keeps the {propertyId, checkIn, checkOut} scan bounded.
          checkIn: { $lt: to, $gte: new Date(from.getTime() - MAX_STAY_NIGHTS * 86_400_000) },
          checkOut: { $gt: from },
          status: { $in: [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN, ReservationStatus.CHECKED_OUT] },
        },
        {
          reservationCode: 1,
          status: 1,
          source: 1,
          guest: 1,
          checkIn: 1,
          checkOut: 1,
          overbooked: 1,
          paymentStatus: 1,
          'reservationRooms._id': 1,
          'reservationRooms.roomTypeId': 1,
          'reservationRooms.roomId': 1,
          'reservationRooms.roomNumber': 1,
        },
      )
        .sort({ checkIn: 1 })
        .lean(),
      this.m.InventoryBlock.find(
        { propertyId, status: InventoryBlockStatus.ACTIVE, startDate: { $lt: to }, endDate: { $gt: from } },
        { roomTypeId: 1, roomId: 1, startDate: 1, endDate: 1, quantity: 1, reason: 1 },
      ).lean(),
    ]);

    const key = (rt: unknown, d: Date) => `${String(rt)}|${d.getTime()}`;
    const invByKey = new Map(inventory.map((i) => [key(i.roomTypeId, i.date), i]));
    const resByKey = new Map(restrictions.map((r) => [key(r.roomTypeId, r.date), r]));

    return {
      from: formatDateOnly(from),
      to: formatDateOnly(to),
      roomTypes: roomTypes.map((rt) => ({
        roomTypeId: rt._id,
        name: rt.name,
        days: days.map<CalendarCell>((d) => {
          const inv = invByKey.get(key(rt._id, d));
          const r = resByKey.get(key(rt._id, d));
          return {
            date: formatDateOnly(d),
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
