import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Permission } from '../../common/access/permissions';
import { PropertyAccessService } from '../../common/access/property-access.service';
import type { AuthUser, PropertyAccessContext } from '../../common/auth/auth-user';
import { Page, escapeLike, pageParams, toUuid } from '../../common/utils';
import { addDays, toDateOnly } from '../../database/common/dates';
import { MAX_STAY_NIGHTS } from '../../database/constants';
import { ReservationStatus } from '../../database/enums';
import { DomainValidationError, ForbiddenError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { Reservation, attachRooms, findReservation } from '../../database/reservation-store';
import { ReservationService } from '../../database/services/reservation.service';
import { d } from '../../database/sql';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import type {
  CancelReservationDto,
  CheckInDto,
  CreateReservationDto,
  ReservationListQueryDto,
  UpdateReservationDto,
} from './reservations.dto';

/**
 * HTTP-facing reservation workflows. All inventory-affecting logic (the transaction, the conditional decrements,
 * rollback) lives in the data-layer ReservationService. After each commit this service flushes the outbox, so channel
 * sync and notifications start at once. If this process dies first, the relay picks them up.
 */
@Injectable()
export class ReservationsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly core: ReservationService,
    private readonly outbox: OutboxDispatcher,
    private readonly access: PropertyAccessService,
  ) {}

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
      guest: dto.guestId ? { guestId: toUuid(dto.guestId, 'guestId') } : { ...dto.guest!, lastName: dto.guest!.lastName ?? '' },
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      adults: dto.adults,
      children: dto.children,
      rooms: dto.rooms.map((r) => ({
        roomTypeId: toUuid(r.roomTypeId, 'roomTypeId'),
        ratePlanId: toUuid(r.ratePlanId, 'ratePlanId'),
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

  async list(propertyId: string, q: ReservationListQueryDto): Promise<Page<Omit<Reservation, 'statusHistory'>>> {
    const p = pageParams(q.page, q.limit);
    let query = this.db.selectFrom('reservations').where('propertyId', '=', propertyId);
    if (q.status) query = query.where('status', '=', q.status);
    if (q.source) query = query.where('source', '=', q.source);
    if (q.from || q.to) {
      const from = q.from ? toDateOnly(q.from) : null;
      const to = q.to ? toDateOnly(q.to) : null;
      // Overlap with [from, to); the MAX_STAY lower bound keeps the index scan bounded.
      if (to) query = query.where('checkIn', '<', d(to));
      if (from) query = query.where('checkIn', '>=', d(addDays(from, -MAX_STAY_NIGHTS))).where('checkOut', '>', d(from));
    }
    if (q.q) {
      const like = `%${escapeLike(q.q.trim())}%`;
      query = query.where((w) =>
        w.or([
          w('reservationCode', '=', q.q!.trim().toUpperCase()),
          w('externalReservationId', '=', q.q!.trim()),
          w(sql`guest->>'firstName'`, 'ilike', like),
          w(sql`guest->>'lastName'`, 'ilike', like),
        ]),
      );
    }
    const [rows, total] = await Promise.all([
      query.selectAll().orderBy('checkIn', 'desc').orderBy('id').offset(p.skip).limit(p.limit).execute(),
      query.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    const items = (await attachRooms(this.db, rows)).map(({ statusHistory: _omit, ...rest }) => rest);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  async get(id: string): Promise<Reservation> {
    const r = await findReservation(this.db, { id });
    if (!r) throw new NotFoundError('Reservation', id);
    return r;
  }

  async update(user: AuthUser, ctx: PropertyAccessContext, id: string, dto: UpdateReservationDto) {
    const r = await this.core.updateReservation({ propertyId: ctx.propertyId, reservationId: id, ...dto, userId: user.userId });
    void this.outbox.flush();
    return r;
  }

  async cancel(user: AuthUser, ctx: PropertyAccessContext, id: string, dto: CancelReservationDto) {
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

  async checkIn(user: AuthUser, ctx: PropertyAccessContext, id: string, dto: CheckInDto) {
    const r = await this.core.checkIn({
      propertyId: ctx.propertyId,
      reservationId: id,
      assignments: dto.assignments?.map((a) => ({
        reservationRoomId: toUuid(a.reservationRoomId, 'reservationRoomId'),
        roomId: toUuid(a.roomId, 'roomId'),
      })),
      userId: user.userId,
    });
    void this.outbox.flush();
    return r;
  }

  async checkOut(user: AuthUser, ctx: PropertyAccessContext, id: string) {
    const r = await this.core.checkOut({ propertyId: ctx.propertyId, reservationId: id, userId: user.userId });
    void this.outbox.flush();
    return r;
  }

  async noShow(user: AuthUser, ctx: PropertyAccessContext, id: string) {
    const r = await this.core.markNoShow({ propertyId: ctx.propertyId, reservationId: id, userId: user.userId });
    void this.outbox.flush();
    return r;
  }

  async assignRoom(user: AuthUser, ctx: PropertyAccessContext, id: string, reservationRoomId: string, roomId: string) {
    return this.core.assignRoom({
      propertyId: ctx.propertyId,
      reservationId: id,
      reservationRoomId: toUuid(reservationRoomId, 'reservationRoomId'),
      roomId: toUuid(roomId, 'roomId'),
      userId: user.userId,
    });
  }
}
