import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccessService } from '../../common/access/property-access.service';
import type { AuthUser, PropertyAccessContext } from '../../common/auth/auth-user';
import { Page, escapeRegex, pageParams, toObjectId } from '../../common/utils';
import { addDays, toDateOnly } from '../../database/common/dates';
import { MAX_STAY_NIGHTS } from '../../database/constants';
import { ReservationStatus } from '../../database/enums';
import { DomainValidationError, ForbiddenError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { Reservation } from '../../database/schemas/reservation.schema';
import { ReservationService } from '../../database/services/reservation.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import type {
  CancelReservationDto,
  CheckInDto,
  CreateReservationDto,
  ReservationListQueryDto,
  UpdateReservationDto,
} from './reservations.dto';

/**
 * HTTP-facing reservation workflows. All inventory-affecting logic (the
 * transaction, the conditional decrements, rollback) lives in the data-layer
 * ReservationService. After each commit this service flushes the outbox, so
 * channel sync and notifications start at once. If this process dies first,
 * the relay picks them up.
 */
@Injectable()
export class ReservationsService {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly core: ReservationService,
    private readonly outbox: OutboxDispatcher,
    private readonly access: PropertyAccessService,
  ) {
    this.m = getModels(connection);
  }

  async create(user: AuthUser, ctx: PropertyAccessContext, dto: CreateReservationDto, idempotencyKey?: string) {
    if (!dto.guestId && !dto.guest) throw new DomainValidationError('Either guestId or guest is required');
    if (dto.discount !== undefined || dto.rooms.some((r) => r.nightlyRates)) {
      // Manual pricing is a rates permission, not a front-desk one.
      if (!this.access.can(ctx, Permission.RATES_MANAGE)) throw new ForbiddenError('Price overrides need rates:manage');
    }
    const result = await this.core.createReservation({
      propertyId: ctx.propertyId,
      source: dto.source,
      idempotencyKey,
      status: dto.status ?? ReservationStatus.CONFIRMED,
      guest: dto.guestId ? { guestId: toObjectId(dto.guestId, 'guestId') } : { ...dto.guest!, lastName: dto.guest!.lastName ?? '' },
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      adults: dto.adults,
      children: dto.children,
      rooms: dto.rooms.map((r) => ({
        roomTypeId: toObjectId(r.roomTypeId, 'roomTypeId'),
        ratePlanId: toObjectId(r.ratePlanId, 'ratePlanId'),
        quantity: r.quantity,
        nightlyRates: r.nightlyRates,
      })),
      discount: dto.discount,
      specialRequests: dto.specialRequests,
      createdBy: user.userId,
    });
    void this.outbox.flush();
    return result;
  }

  async list(propertyId: Types.ObjectId, q: ReservationListQueryDto): Promise<Page<Reservation>> {
    const p = pageParams(q.page, q.limit);
    const filter: Record<string, unknown> = { propertyId };
    if (q.status) filter.status = q.status;
    if (q.source) filter.source = q.source;
    if (q.from || q.to) {
      const from = q.from ? toDateOnly(q.from) : null;
      const to = q.to ? toDateOnly(q.to) : null;
      // Overlap with [from, to); the MAX_STAY lower bound keeps the index scan bounded.
      filter.checkIn = { ...(to ? { $lt: to } : {}), ...(from ? { $gte: addDays(from, -MAX_STAY_NIGHTS) } : {}) };
      if (from) filter.checkOut = { $gt: from };
    }
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      filter.$or = [{ reservationCode: q.q.toUpperCase() }, { externalReservationId: q.q }, { 'guest.firstName': rx }, { 'guest.lastName': rx }];
    }
    const [items, total] = await Promise.all([
      this.m.Reservation.find(filter, { statusHistory: 0 }).sort({ checkIn: -1 }).skip(p.skip).limit(p.limit).lean(),
      this.m.Reservation.countDocuments(filter),
    ]);
    return { items, page: p.page, limit: p.limit, total };
  }

  async get(id: Types.ObjectId): Promise<Reservation> {
    const r = await this.m.Reservation.findById(id).lean();
    if (!r) throw new NotFoundError('Reservation', id);
    return r;
  }

  async update(user: AuthUser, ctx: PropertyAccessContext, id: Types.ObjectId, dto: UpdateReservationDto) {
    const r = await this.core.updateReservation({ propertyId: ctx.propertyId, reservationId: id, ...dto, userId: user.userId });
    void this.outbox.flush();
    return r;
  }

  async cancel(user: AuthUser, ctx: PropertyAccessContext, id: Types.ObjectId, dto: CancelReservationDto) {
    if (dto.refundAmount !== undefined && !this.access.can(ctx, Permission.PAYMENTS_REFUND)) {
      throw new ForbiddenError('Overriding the refund amount needs payments:refund');
    }
    const res = await this.core.cancelReservation({
      propertyId: ctx.propertyId,
      reservationId: id,
      reason: dto.reason,
      cancelledBy: user.userId,
      refundAmount: dto.refundAmount,
    });
    void this.outbox.flush();
    return res;
  }

  async checkIn(user: AuthUser, ctx: PropertyAccessContext, id: Types.ObjectId, dto: CheckInDto) {
    const r = await this.core.checkIn({
      propertyId: ctx.propertyId,
      reservationId: id,
      assignments: dto.assignments?.map((a) => ({
        reservationRoomId: toObjectId(a.reservationRoomId, 'reservationRoomId'),
        roomId: toObjectId(a.roomId, 'roomId'),
      })),
      userId: user.userId,
    });
    void this.outbox.flush();
    return r;
  }

  async checkOut(user: AuthUser, ctx: PropertyAccessContext, id: Types.ObjectId) {
    const r = await this.core.checkOut({ propertyId: ctx.propertyId, reservationId: id, userId: user.userId });
    void this.outbox.flush();
    return r;
  }

  async noShow(user: AuthUser, ctx: PropertyAccessContext, id: Types.ObjectId) {
    const r = await this.core.markNoShow({ propertyId: ctx.propertyId, reservationId: id, userId: user.userId });
    void this.outbox.flush();
    return r;
  }

  async assignRoom(user: AuthUser, ctx: PropertyAccessContext, id: Types.ObjectId, reservationRoomId: string, roomId: string) {
    return this.core.assignRoom({
      propertyId: ctx.propertyId,
      reservationId: id,
      reservationRoomId: toObjectId(reservationRoomId, 'reservationRoomId'),
      roomId: toObjectId(roomId, 'roomId'),
      userId: user.userId,
    });
  }
}
