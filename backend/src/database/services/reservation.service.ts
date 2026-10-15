import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomInt } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { Connection, HydratedDocument, Types } from 'mongoose';
import { DEFAULT_PENDING_HOLD_MINUTES, MAX_STAY_NIGHTS } from '../constants';
import { DateInput, addDays, eachNight, formatDateOnly, localDateTimeToInstant, todayIn, toDateOnly } from '../common/dates';
import { percentOf, sum } from '../common/money';
import { evaluateRestrictions } from '../common/restrictions';
import { isDuplicateKeyError } from '../common/schema-helpers';
import { runInTransaction } from '../common/transaction';
import {
  CancellationPenaltyType,
  NotificationChannel,
  NotificationType,
  OTA_SOURCES,
  PaymentProvider,
  PaymentStatus,
  PropertyStatus,
  RatePlanStatus,
  RefundStatus,
  ReservationPaymentStatus,
  ReservationSource,
  ReservationStatus,
  RoomStatus,
  RoomTypeStatus,
  SyncEntityType,
  SyncJobType,
} from '../enums';
import {
  ConflictError,
  DomainValidationError,
  InvalidStateTransitionError,
  NotFoundError,
  RestrictionViolationError,
} from '../errors';
import { Models, getModels } from '../models';
import type { Payment, Refund } from '../schemas/payment.schema';
import type { Property, RatePlan, RoomType } from '../schemas/property.schema';
import type { GuestSnapshot, Reservation, ReservationRoom } from '../schemas/reservation.schema';
import { AuditService } from './audit.service';
import { ClientEventService } from './client-event.service';
import { InventoryService } from './inventory.service';
import { SyncJobService } from './sync-job.service';

type Id = Types.ObjectId;

export interface CreateReservationInput {
  propertyId: Id;
  source: ReservationSource;
  externalReservationId?: string;
  channelListingId?: Id | null;
  /** Direct bookings: a client-generated UUID so a retried request cannot book twice. */
  idempotencyKey?: string;
  /** Defaults: OTA/walk-in/phone/agent → CONFIRMED; DIRECT/TIRVONA → PENDING (awaiting payment). */
  status?: ReservationStatus.PENDING | ReservationStatus.CONFIRMED;
  guest: { guestId: Id } | (GuestSnapshot & { country?: string });
  checkIn: DateInput;
  checkOut: DateInput;
  adults: number;
  children?: number;
  rooms: Array<{
    roomTypeId: Id;
    ratePlanId?: Id | null;
    quantity: number;
    /** Per-night prices sent by an OTA, or entered by staff. Public direct bookings are always priced by us. */
    nightlyRates?: number[];
  }>;
  discount?: number;
  specialRequests?: string;
  /** OTA collected the money (Booking.com "Payments by Booking", Airbnb, ...). */
  paymentCollectedByChannel?: boolean;
  createdBy?: Id | null;
  /** Extra context for the audit log (promo code, client IP, ...). */
  auditMetadata?: Record<string, unknown>;
}

export interface CreateReservationResult {
  reservation: Reservation;
  /** False when an idempotent retry or duplicate OTA delivery returned the existing booking. */
  created: boolean;
}

const CANCELLABLE = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED];
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

@Injectable()
export class ReservationService {
  private readonly m: Models;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly inventory: InventoryService,
    private readonly syncJobs: SyncJobService,
    private readonly audit: AuditService,
    private readonly clientEvents: ClientEventService,
  ) {
    this.m = getModels(connection);
  }

  // ================================================================ create

  /**
   * The reservation transaction:
   *
   *   1. Idempotency short-circuit (source+externalReservationId or idempotencyKey).
   *   2. Validate property, room types, rate plans, dates, occupancy and horizon.
   *   3. Price every night from the rate plan (or accept the OTA's prices) and
   *      freeze them on the reservation.
   *   4. In ONE transaction:
   *        restrictions check → guest upsert → inventory.reserve for each room type
   *        (all nights, all-or-nothing) → insert reservation → outbox rows
   *        (sync_jobs, notifications) → audit log.
   *   5. A duplicate-key error on the external/idempotency index means a
   *      concurrent delivery won the race; return that reservation instead.
   */
  async createReservation(input: CreateReservationInput): Promise<CreateReservationResult> {
    const checkIn = toDateOnly(input.checkIn);
    const checkOut = toDateOnly(input.checkOut);
    const nights = eachNight(checkIn, checkOut);
    if (nights.length < 1) throw new DomainValidationError('checkOut must be after checkIn');
    if (nights.length > MAX_STAY_NIGHTS) throw new DomainValidationError(`Stays are limited to ${MAX_STAY_NIGHTS} nights`);
    if (!input.rooms.length) throw new DomainValidationError('At least one room is required');
    if (input.rooms.some((r) => !Number.isInteger(r.quantity) || r.quantity < 1)) {
      throw new DomainValidationError('Room quantity must be a positive integer');
    }
    const isOta = OTA_SOURCES.has(input.source);
    const isPublicDirect = input.source === ReservationSource.DIRECT || input.source === ReservationSource.TIRVONA;
    if (isOta && !input.externalReservationId) throw new DomainValidationError('externalReservationId is required for OTA bookings');

    const existing = await this.findIdempotent(input);
    if (existing) return { reservation: existing, created: false };

    // ---- reference data (read outside the transaction: it is not what we are guarding)
    const property = await this.m.Property.findById(input.propertyId).lean();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    if (!isOta && property.status !== PropertyStatus.ACTIVE) throw new DomainValidationError('Property is not accepting bookings');

    if (!isOta) {
      const today = todayIn(property.timezone);
      if (checkIn < today) throw new DomainValidationError('checkIn is in the past');
      if (checkOut > addDays(today, property.bookingHorizonDays)) {
        throw new DomainValidationError(`Bookings are open ${property.bookingHorizonDays} days ahead`);
      }
    }

    const roomTypeIds = uniqueIds(input.rooms.map((r) => r.roomTypeId));
    const ratePlanIds = uniqueIds(input.rooms.flatMap((r) => (r.ratePlanId ? [r.ratePlanId] : [])));
    const [roomTypes, ratePlans] = await Promise.all([
      this.m.RoomType.find({ _id: { $in: roomTypeIds }, propertyId: property._id }).lean(),
      this.m.RatePlan.find({ _id: { $in: ratePlanIds }, propertyId: property._id }).lean(),
    ]);
    const rtById = new Map(roomTypes.map((rt) => [String(rt._id), rt]));
    const rpById = new Map(ratePlans.map((rp) => [String(rp._id), rp]));

    const lines = this.priceLines(input, property, rtById, rpById, nights, { isOta, isPublicDirect });
    const demand = new Map<string, number>();
    for (const l of lines) demand.set(String(l.roomTypeId), (demand.get(String(l.roomTypeId)) ?? 0) + l.quantity);

    const capacity = sum(input.rooms.map((r) => rtById.get(String(r.roomTypeId))!.maxOccupancy * r.quantity));
    if (!isOta && input.adults + (input.children ?? 0) > capacity) {
      throw new DomainValidationError(`Selected rooms sleep at most ${capacity} guests`);
    }

    // OTA bookings may land beyond our materialised horizon; make sure the rows exist.
    if (isOta) for (const rtId of roomTypeIds) await this.inventory.ensureInventory(property._id, rtId, checkIn, checkOut);

    const subtotal = sum(lines.map((l) => l.subtotal));
    const tax = sum(lines.map((l) => l.tax));
    const discount = input.discount ?? 0;
    if (!Number.isInteger(discount) || discount < 0 || discount > subtotal + tax) throw new DomainValidationError('Invalid discount');

    const status =
      input.status ?? (isPublicDirect ? ReservationStatus.PENDING : ReservationStatus.CONFIRMED);
    const channelCollected = isOta && !!input.paymentCollectedByChannel;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await runInTransaction(this.connection, async (session) => {
          if (!isOta) await this.assertRestrictions(session, property._id, roomTypeIds, checkIn, checkOut);

          const guest = await this.resolveGuest(session, property._id, input.guest);

          let overbookedUnits = 0;
          for (const [rtId, quantity] of demand) {
            const r = await this.inventory.reserve(session, {
              propertyId: property._id,
              roomTypeId: new Types.ObjectId(rtId),
              checkIn,
              checkOut,
              quantity,
              allowOverbooking: isOta,
            });
            overbookedUnits += r.overbookedUnits;
          }

          const now = new Date();
          const [doc] = await this.m.Reservation.create(
            [
              {
                propertyId: property._id,
                reservationCode: newReservationCode(),
                source: input.source,
                externalReservationId: input.externalReservationId,
                channelListingId: input.channelListingId ?? null,
                idempotencyKey: input.idempotencyKey,
                status,
                guestId: guest._id,
                guest: { firstName: guest.firstName, lastName: guest.lastName, email: guest.email, phone: guest.phone },
                checkIn,
                checkOut,
                nights: nights.length,
                adults: input.adults,
                children: input.children ?? 0,
                specialRequests: input.specialRequests,
                reservationRooms: lines,
                subtotal,
                tax,
                discount,
                total: subtotal + tax - discount,
                currency: property.currency,
                paymentStatus: channelCollected ? ReservationPaymentStatus.CHANNEL_COLLECTED : ReservationPaymentStatus.UNPAID,
                holdExpiresAt:
                  status === ReservationStatus.PENDING ? new Date(now.getTime() + DEFAULT_PENDING_HOLD_MINUTES * 60_000) : null,
                overbooked: overbookedUnits > 0,
                statusHistory: [{ status, at: now, by: input.createdBy ?? null }],
                createdBy: input.createdBy ?? null,
              },
            ],
            { session },
          );

          for (const rtId of demand.keys()) {
            await this.syncJobs.enqueueForRoomType(session, {
              propertyId: property._id,
              roomTypeId: new Types.ObjectId(rtId),
              types: [SyncJobType.INVENTORY],
              dateFrom: checkIn,
              dateTo: checkOut,
              entityType: SyncEntityType.RESERVATION,
              entityId: doc._id,
            });
          }
          await this.queueNotifications(session, property, doc.toObject(), overbookedUnits);
          await this.audit.record(session, {
            organizationId: property.organizationId,
            propertyId: property._id,
            userId: input.createdBy ?? null,
            action: 'reservation.create',
            entityType: 'Reservation',
            entityId: doc._id,
            after: { reservationCode: doc.reservationCode, status, source: input.source, checkIn, checkOut, total: doc.total },
            metadata: { ...(input.auditMetadata ?? {}), ...(overbookedUnits ? { overbookedUnits } : {}) },
          });
          return { reservation: doc.toObject(), created: true };
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        if (err.keyPattern?.reservationCode) continue; // 1-in-10^12 code collision: new code, new attempt
        const winner = await this.findIdempotent(input);
        if (winner) return { reservation: winner, created: false };
        throw err;
      }
    }
    throw new Error('Could not allocate a unique reservation code');
  }

  // ================================================================ cancel

  /**
   * The cancellation transaction:
   *   conditional status flip (PENDING|CONFIRMED → CANCELLED) → release every
   *   night of every room → PENDING refund rows per the frozen cancellation
   *   policy → outbox (sync_jobs, notification) → audit.
   * Cancelling an already-cancelled reservation is a no-op that returns it,
   * because OTAs re-send cancellations.
   */
  async cancelReservation(input: {
    propertyId: Id;
    reservationId: Id;
    reason: string;
    cancelledBy?: Id | null;
    /** Override the policy-computed refund (minor units). Staff only. */
    refundAmount?: number;
    now?: Date;
  }): Promise<{ reservation: Reservation; refunds: Refund[]; alreadyCancelled: boolean }> {
    const now = input.now ?? new Date();
    const property = await this.m.Property.findById(input.propertyId).lean();
    if (!property) throw new NotFoundError('Property', input.propertyId);

    return runInTransaction(this.connection, async (session) => {
      const r = await this.m.Reservation.findOne({ _id: input.reservationId, propertyId: input.propertyId }).session(session).lean();
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (r.status === ReservationStatus.CANCELLED) return { reservation: r, refunds: [], alreadyCancelled: true };
      if (!CANCELLABLE.includes(r.status)) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.CANCELLED);

      // Conditional flip: of two concurrent cancels, exactly one releases inventory.
      const flipped = await this.m.Reservation.findOneAndUpdate(
        { _id: r._id, status: { $in: CANCELLABLE } },
        {
          $set: {
            status: ReservationStatus.CANCELLED,
            cancelledAt: now,
            cancellationReason: input.reason,
            holdExpiresAt: null,
            inventoryReleasedFrom: r.checkIn,
          },
          $push: { statusHistory: { status: ReservationStatus.CANCELLED, at: now, by: input.cancelledBy ?? null, reason: input.reason } },
        },
        { session, new: true },
      ).lean();
      if (!flipped) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.CANCELLED);

      for (const [rtId, quantity] of demandOf(r.reservationRooms)) {
        await this.inventory.release(session, {
          propertyId: r.propertyId,
          roomTypeId: new Types.ObjectId(rtId),
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          quantity,
        });
      }

      const refunds =
        r.paymentStatus === ReservationPaymentStatus.CHANNEL_COLLECTED
          ? [] // the OTA refunds its own guest
          : await this.createRefunds(session, r, input.refundAmount ?? this.policyRefund(r, property, now), input.reason, input.cancelledBy ?? null);

      for (const [rtId] of demandOf(r.reservationRooms)) {
        await this.syncJobs.enqueueForRoomType(session, {
          propertyId: r.propertyId,
          roomTypeId: new Types.ObjectId(rtId),
          types: [SyncJobType.INVENTORY],
          dateFrom: r.checkIn,
          dateTo: r.checkOut,
          entityType: SyncEntityType.RESERVATION,
          entityId: r._id,
        });
      }
      if (r.guest.email) {
        await this.m.Notification.create(
          [
            {
              propertyId: r.propertyId,
              reservationId: r._id,
              type: NotificationType.RESERVATION_CANCELLED,
              channel: NotificationChannel.EMAIL,
              recipient: r.guest.email,
              subject: `Reservation ${r.reservationCode} cancelled`,
              message: `Your reservation ${r.reservationCode} at ${property.name} has been cancelled.`,
              metadata: { refundTotal: sum(refunds.map((x) => x.amount)) },
            },
          ],
          { session },
        );
      }
      await this.audit.record(session, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.cancelledBy ?? null,
        action: 'reservation.cancel',
        entityType: 'Reservation',
        entityId: r._id,
        before: { status: r.status },
        after: { status: ReservationStatus.CANCELLED, reason: input.reason, refunds: refunds.map((x) => x.amount) },
      });
      await this.clientEvents.emit(session, { type: 'reservation.cancelled', property, reservation: flipped });
      return { reservation: flipped, refunds, alreadyCancelled: false };
    });
  }

  /** OTA cancellations arrive with the channel's ID, not ours. */
  async cancelByExternalId(source: ReservationSource, externalReservationId: string, reason: string) {
    const r = await this.m.Reservation.findOne({ source, externalReservationId }, { _id: 1, propertyId: 1 }).lean();
    if (!r) throw new NotFoundError(`${source} reservation`, externalReservationId);
    return this.cancelReservation({ propertyId: r.propertyId, reservationId: r._id, reason });
  }

  /** Scheduled sweeper: release inventory held by unpaid PENDING bookings whose hold expired. */
  async expirePendingHolds(now = new Date(), batch = 100): Promise<number> {
    const due = await this.m.Reservation.find(
      { status: ReservationStatus.PENDING, holdExpiresAt: { $type: 'date', $lte: now } },
      { _id: 1, propertyId: 1 },
    )
      .limit(batch)
      .lean();
    let expired = 0;
    for (const r of due) {
      try {
        const res = await this.cancelReservation({ propertyId: r.propertyId, reservationId: r._id, reason: 'Payment hold expired', now });
        if (!res.alreadyCancelled) expired++;
      } catch (err) {
        // A payment confirmed it in the meantime (status is no longer PENDING). Skip it.
        if (!(err instanceof InvalidStateTransitionError)) throw err;
      }
    }
    return expired;
  }

  // ================================================================ payments

  /**
   * Record a captured payment (cash, bank transfer, or a verified gateway
   * payment without a prior order row). This is idempotent on
   * provider+providerPaymentId. See applyCapturedPayment for the effects on
   * the reservation.
   */
  async recordPayment(input: {
    propertyId: Id;
    reservationId: Id;
    provider: PaymentProvider;
    providerPaymentId?: string;
    providerOrderId?: string;
    amount: number;
    currency: string;
    status: PaymentStatus.PAID | PaymentStatus.AUTHORIZED;
    metadata?: Record<string, unknown>;
    createdBy?: Id | null;
  }): Promise<{ payment: Payment; duplicate: boolean }> {
    if (!Number.isInteger(input.amount) || input.amount < 1) throw new DomainValidationError('amount must be a positive integer (minor units)');
    if (input.providerPaymentId) {
      const dup = await this.m.Payment.findOne({ provider: input.provider, providerPaymentId: input.providerPaymentId }).lean();
      if (dup) return { payment: dup, duplicate: true };
    }
    try {
      return await runInTransaction(this.connection, async (session) => {
        const r = await this.m.Reservation.findOne({ _id: input.reservationId, propertyId: input.propertyId }).session(session).lean();
        if (!r) throw new NotFoundError('Reservation', input.reservationId);
        if (r.currency !== input.currency) throw new DomainValidationError(`Payment currency must be ${r.currency}`);

        const now = new Date();
        const [payment] = await this.m.Payment.create(
          [
            {
              propertyId: r.propertyId,
              reservationId: r._id,
              provider: input.provider,
              providerPaymentId: input.providerPaymentId,
              providerOrderId: input.providerOrderId,
              amount: input.amount,
              currency: input.currency,
              status: input.status,
              paidAt: input.status === PaymentStatus.PAID ? now : undefined,
              metadata: input.metadata ?? {},
              createdBy: input.createdBy ?? null,
            },
          ],
          { session },
        );
        const confirmed =
          input.status === PaymentStatus.PAID ? (await this.applyCapturedPayment(session, r, input.amount, now)).confirmed : false;
        await this.audit.record(session, {
          propertyId: r.propertyId,
          userId: input.createdBy ?? null,
          action: 'payment.record',
          entityType: 'Payment',
          entityId: payment._id,
          after: { reservationId: r._id, amount: input.amount, provider: input.provider, status: input.status, confirmed },
        });
        return { payment: payment.toObject(), duplicate: false };
      });
    } catch (err) {
      if (isDuplicateKeyError(err) && input.providerPaymentId) {
        const dup = await this.m.Payment.findOne({ provider: input.provider, providerPaymentId: input.providerPaymentId }).lean();
        if (dup) return { payment: dup, duplicate: true };
      }
      throw err;
    }
  }

  /**
   * Effects of money arriving, inside the caller's transaction. The payment row
   * must already be PAID in the same session. It raises amountPaid and
   * paymentStatus, confirms a PENDING booking (ending its hold), and queues
   * guest notifications. If the booking was cancelled first (the hold expired
   * while the guest was paying), the money is queued straight back as a refund.
   */
  async applyCapturedPayment(session: ClientSession, r: Reservation, amount: number, now = new Date()): Promise<{ confirmed: boolean }> {
    const amountPaid = r.amountPaid + amount;
    const paymentStatus = amountPaid >= r.total ? ReservationPaymentStatus.PAID : ReservationPaymentStatus.PARTIALLY_PAID;
    const confirm = r.status === ReservationStatus.PENDING;
    const wasPaid = r.amountPaid;
    await this.m.Reservation.updateOne(
      { _id: r._id },
      {
        $set: { amountPaid, paymentStatus, ...(confirm ? { status: ReservationStatus.CONFIRMED, holdExpiresAt: null } : {}) },
        ...(confirm
          ? { $push: { statusHistory: { status: ReservationStatus.CONFIRMED, at: now, by: null, reason: 'Payment received' } } }
          : {}),
      },
      { session },
    );
    const notifications: Record<string, unknown>[] = [];
    if (r.guest.email) {
      notifications.push({
        propertyId: r.propertyId,
        reservationId: r._id,
        type: NotificationType.PAYMENT_SUCCESS,
        channel: NotificationChannel.EMAIL,
        recipient: r.guest.email,
        subject: `Payment received for ${r.reservationCode}`,
        message: `We received your payment of ${formatMoney(amount, r.currency)} for reservation ${r.reservationCode}.`,
      });
      if (confirm) {
        notifications.push({
          propertyId: r.propertyId,
          reservationId: r._id,
          type: NotificationType.RESERVATION_CONFIRMED,
          channel: NotificationChannel.EMAIL,
          recipient: r.guest.email,
          subject: `Booking confirmed: ${r.reservationCode}`,
          message: `Your reservation ${r.reservationCode} is confirmed.`,
        });
      }
    }
    if (notifications.length) await this.m.Notification.create(notifications, { session, ordered: true });
    const eventProperty = await this.m.Property.findById(r.propertyId, { organizationId: 1, slug: 1, name: 1 }).session(session).lean();
    if (eventProperty) {
      const after: Reservation = { ...r, amountPaid, paymentStatus, ...(confirm ? { status: ReservationStatus.CONFIRMED, holdExpiresAt: null } : {}) };
      const payment = { amount, currency: r.currency, totalPaid: amountPaid };
      // The previous amountPaid makes the id unique per payment while staying stable if this transaction is retried.
      await this.clientEvents.emit(session, { type: 'payment.succeeded', property: eventProperty, reservation: after, discriminator: String(wasPaid), extra: { payment } });
      if (confirm) await this.clientEvents.emit(session, { type: 'reservation.confirmed', property: eventProperty, reservation: after });
    }
    if (r.status === ReservationStatus.CANCELLED) {
      await this.createRefunds(session, { ...r, amountPaid }, amount, 'Payment received after cancellation', null);
    }
    return { confirmed: confirm };
  }

  // ================================================================ updates & date changes

  /**
   * PATCH semantics. Contact and notes changes are a plain update. A date
   * change runs as ONE transaction: release every old night → reserve every
   * new night (all-or-nothing, same guard as a new booking) → re-price. Nights
   * kept from the old stay keep their frozen price; new nights get the rate
   * plan's current price (or the OTA's price) → re-check physical room
   * assignments → outbox + audit.
   */
  async updateReservation(input: {
    propertyId: Id;
    reservationId: Id;
    checkIn?: DateInput;
    checkOut?: DateInput;
    adults?: number;
    children?: number;
    specialRequests?: string;
    guest?: Partial<GuestSnapshot>;
    /** OTA modifications: new prices per expanded line. */
    nightlyRatesByLine?: number[][];
    userId?: Id | null;
  }): Promise<Reservation> {
    const property = await this.m.Property.findById(input.propertyId).lean();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    const current = await this.m.Reservation.findOne({ _id: input.reservationId, propertyId: input.propertyId }).lean();
    if (!current) throw new NotFoundError('Reservation', input.reservationId);
    const isOta = OTA_SOURCES.has(current.source);
    const newIn = input.checkIn ? toDateOnly(input.checkIn) : current.checkIn;
    const newOut = input.checkOut ? toDateOnly(input.checkOut) : current.checkOut;
    const datesChanged = newIn.getTime() !== current.checkIn.getTime() || newOut.getTime() !== current.checkOut.getTime();
    const nights = eachNight(newIn, newOut);
    if (nights.length < 1) throw new DomainValidationError('checkOut must be after checkIn');
    if (nights.length > MAX_STAY_NIGHTS) throw new DomainValidationError(`Stays are limited to ${MAX_STAY_NIGHTS} nights`);
    if (datesChanged && isOta) {
      for (const rtId of demandOf(current.reservationRooms).keys()) {
        await this.inventory.ensureInventory(current.propertyId, new Types.ObjectId(rtId), newIn, newOut);
      }
    }

    return runInTransaction(this.connection, async (session) => {
      const r = await this.m.Reservation.findOne({ _id: input.reservationId, propertyId: input.propertyId }).session(session);
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      const editable = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN];
      if (!editable.includes(r.status)) throw new InvalidStateTransitionError('Reservation', r.status, 'MODIFIED');
      const before = { checkIn: r.checkIn, checkOut: r.checkOut, adults: r.adults, children: r.children, total: r.total };

      if (datesChanged) {
        if (r.status === ReservationStatus.CHECKED_IN && newIn.getTime() !== r.checkIn.getTime()) {
          throw new DomainValidationError('The arrival date of a checked-in stay cannot change');
        }
        if (!isOta && r.status !== ReservationStatus.CHECKED_IN && newIn < todayIn(property.timezone)) {
          throw new DomainValidationError('checkIn is in the past');
        }
        const demand = demandOf(r.reservationRooms);
        for (const [rtId, quantity] of demand) {
          await this.inventory.release(session, { propertyId: r.propertyId, roomTypeId: new Types.ObjectId(rtId), checkIn: r.checkIn, checkOut: r.checkOut, quantity });
        }
        let overbookedUnits = 0;
        for (const [rtId, quantity] of demand) {
          const res = await this.inventory.reserve(session, {
            propertyId: r.propertyId,
            roomTypeId: new Types.ObjectId(rtId),
            checkIn: newIn,
            checkOut: newOut,
            quantity,
            allowOverbooking: isOta,
          });
          overbookedUnits += res.overbookedUnits;
        }

        const ratePlans = await this.m.RatePlan.find({ _id: { $in: r.reservationRooms.flatMap((l) => (l.ratePlanId ? [l.ratePlanId] : [])) } })
          .session(session)
          .lean();
        const rpById = new Map(ratePlans.map((rp) => [String(rp._id), rp]));
        for (const [i, line] of r.reservationRooms.entries()) {
          const old = new Map(line.nightlyRates.map((n) => [n.date.getTime(), n.amount]));
          const fallback = line.nightlyRates[line.nightlyRates.length - 1]?.amount ?? 0;
          const provided = input.nightlyRatesByLine?.[i];
          if (provided && provided.length !== nights.length) throw new DomainValidationError('nightlyRatesByLine must have one price per night');
          const planPrice = line.ratePlanId ? rpById.get(String(line.ratePlanId))?.basePrice : undefined;
          const rates = nights.map((d, j) => provided?.[j] ?? old.get(d.getTime()) ?? planPrice ?? fallback);
          line.nightlyRates = nights.map((date, j) => ({ date, amount: rates[j] })) as never;
          line.subtotal = sum(rates) * line.quantity;
          line.tax = percentOf(line.subtotal, property.taxPercent);
          line.total = line.subtotal + line.tax;

          if (line.roomId) {
            await this.m.Room.updateOne({ _id: line.roomId }, { $inc: { assignmentVersion: 1 } }, { session });
            try {
              await this.inventory.assertRoomFree(session, { roomId: line.roomId, from: newIn, to: newOut, excludeReservationId: r._id });
            } catch (err) {
              // A checked-in guest cannot lose their room. For future stays the line is unassigned for staff to re-assign.
              if (r.status === ReservationStatus.CHECKED_IN) throw err;
              line.roomId = null;
              line.roomNumber = null;
            }
          }
        }
        r.checkIn = newIn;
        r.checkOut = newOut;
        r.nights = nights.length;
        r.subtotal = sum(r.reservationRooms.map((l) => l.subtotal));
        r.tax = sum(r.reservationRooms.map((l) => l.tax));
        r.discount = Math.min(r.discount, r.subtotal + r.tax);
        r.total = r.subtotal + r.tax - r.discount;
        if (overbookedUnits) r.overbooked = true;
        if (r.paymentStatus !== ReservationPaymentStatus.CHANNEL_COLLECTED && r.amountPaid > 0) {
          r.paymentStatus = r.amountPaid >= r.total ? ReservationPaymentStatus.PAID : ReservationPaymentStatus.PARTIALLY_PAID;
        }
      }

      if (input.adults !== undefined) r.adults = input.adults;
      if (input.children !== undefined) r.children = input.children;
      if (!isOta && (input.adults !== undefined || input.children !== undefined)) {
        const types = await this.m.RoomType.find({ _id: { $in: [...demandOf(r.reservationRooms).keys()] } }, { maxOccupancy: 1 })
          .session(session)
          .lean();
        const cap = new Map(types.map((t) => [String(t._id), t.maxOccupancy]));
        const capacity = sum(r.reservationRooms.map((l) => (cap.get(String(l.roomTypeId)) ?? 0) * l.quantity));
        if (r.adults + r.children > capacity) throw new DomainValidationError(`Rooms on this reservation sleep at most ${capacity} guests`);
      }
      if (input.specialRequests !== undefined) r.specialRequests = input.specialRequests;
      if (input.guest) {
        for (const k of ['firstName', 'lastName', 'email', 'phone'] as const) {
          if (input.guest[k] !== undefined) (r.guest as unknown as Record<string, unknown>)[k] = input.guest[k];
        }
      }
      await r.save({ session });

      if (datesChanged) {
        const from = new Date(Math.min(before.checkIn.getTime(), newIn.getTime()));
        const to = new Date(Math.max(before.checkOut.getTime(), newOut.getTime()));
        for (const rtId of demandOf(r.reservationRooms).keys()) {
          await this.syncJobs.enqueueForRoomType(session, {
            propertyId: r.propertyId,
            roomTypeId: new Types.ObjectId(rtId),
            types: [SyncJobType.INVENTORY],
            dateFrom: from,
            dateTo: to,
            entityType: SyncEntityType.RESERVATION,
            entityId: r._id,
          });
        }
      }
      await this.audit.record(session, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: datesChanged ? 'reservation.modify_dates' : 'reservation.update',
        entityType: 'Reservation',
        entityId: r._id,
        before,
        after: { checkIn: r.checkIn, checkOut: r.checkOut, adults: r.adults, children: r.children, total: r.total },
      });
      return r.toObject();
    });
  }

  /** OTA modifications arrive with the channel's ID. */
  async modifyByExternalId(
    source: ReservationSource,
    externalReservationId: string,
    changes: Omit<Parameters<ReservationService['updateReservation']>[0], 'propertyId' | 'reservationId'>,
  ) {
    const r = await this.m.Reservation.findOne({ source, externalReservationId }, { _id: 1, propertyId: 1 }).lean();
    if (!r) throw new NotFoundError(`${source} reservation`, externalReservationId);
    return this.updateReservation({ ...changes, propertyId: r.propertyId, reservationId: r._id });
  }

  // ================================================================ front desk

  /**
   * CONFIRMED → CHECKED_IN. Optional room assignments are applied first, every
   * line must end up with a room, and each room must be AVAILABLE (clean). It
   * becomes OCCUPIED through a conditional update, so two desks cannot put
   * guests into the same room.
   */
  async checkIn(input: {
    propertyId: Id;
    reservationId: Id;
    assignments?: { reservationRoomId: Id; roomId: Id }[];
    userId?: Id | null;
    now?: Date;
  }): Promise<Reservation> {
    const now = input.now ?? new Date();
    const property = await this.m.Property.findById(input.propertyId, { timezone: 1, organizationId: 1 }).lean();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    const today = todayIn(property.timezone, now);

    return runInTransaction(this.connection, async (session) => {
      const r = await this.m.Reservation.findOne({ _id: input.reservationId, propertyId: input.propertyId }).session(session);
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (r.status !== ReservationStatus.CONFIRMED) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.CHECKED_IN);
      if (today < r.checkIn) throw new DomainValidationError(`Check-in opens on ${formatDateOnly(r.checkIn)}`);
      if (today >= r.checkOut) throw new DomainValidationError('This stay has already ended');

      for (const a of input.assignments ?? []) await this.assignInSession(session, r, a.reservationRoomId, a.roomId);
      const unassigned = r.reservationRooms.filter((l) => !l.roomId);
      if (unassigned.length) throw new DomainValidationError('Assign a room to every line before check-in', { lines: unassigned.map((l) => String(l._id)) });

      for (const line of r.reservationRooms) {
        const res = await this.m.Room.updateOne({ _id: line.roomId, status: RoomStatus.AVAILABLE }, { $set: { status: RoomStatus.OCCUPIED } }, { session });
        if (res.modifiedCount !== 1) {
          throw new ConflictError('ROOM_NOT_READY', `Room ${line.roomNumber} is not ready (it must be AVAILABLE)`, { roomId: String(line.roomId) });
        }
      }
      r.status = ReservationStatus.CHECKED_IN;
      r.checkedInAt = now;
      r.statusHistory.push({ status: ReservationStatus.CHECKED_IN, at: now, by: input.userId ?? null });
      await r.save({ session });
      await this.audit.record(session, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: 'reservation.check_in',
        entityType: 'Reservation',
        entityId: r._id,
        after: { rooms: r.reservationRooms.map((l) => l.roomNumber) },
      });
      return r.toObject();
    });
  }

  /**
   * CHECKED_IN → CHECKED_OUT. Rooms go to CLEANING. On an early departure the
   * unused nights [today, checkOut) go back to inventory and are pushed to
   * channels. Charges are not changed automatically; `balanceDue` is returned.
   */
  async checkOut(input: { propertyId: Id; reservationId: Id; userId?: Id | null; now?: Date }): Promise<{ reservation: Reservation; balanceDue: number }> {
    const now = input.now ?? new Date();
    const property = await this.m.Property.findById(input.propertyId, { timezone: 1, organizationId: 1 }).lean();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    const today = todayIn(property.timezone, now);

    return runInTransaction(this.connection, async (session) => {
      const r = await this.m.Reservation.findOne({ _id: input.reservationId, propertyId: input.propertyId }).session(session);
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (r.status !== ReservationStatus.CHECKED_IN) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.CHECKED_OUT);

      for (const line of r.reservationRooms) {
        await this.m.Room.updateOne({ _id: line.roomId, status: RoomStatus.OCCUPIED }, { $set: { status: RoomStatus.CLEANING } }, { session });
      }
      if (today < r.checkOut) await this.releaseRemainingNights(session, r, today > r.checkIn ? today : r.checkIn);
      r.status = ReservationStatus.CHECKED_OUT;
      r.checkedOutAt = now;
      r.statusHistory.push({ status: ReservationStatus.CHECKED_OUT, at: now, by: input.userId ?? null });
      await r.save({ session });
      await this.audit.record(session, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: 'reservation.check_out',
        entityType: 'Reservation',
        entityId: r._id,
        after: { early: today < r.checkOut, inventoryReleasedFrom: r.inventoryReleasedFrom },
      });
      const reservation = r.toObject();
      return { reservation, balanceDue: Math.max(0, reservation.total - (reservation.amountPaid - reservation.amountRefunded)) };
    });
  }

  /** CONFIRMED → NO_SHOW, from the arrival date on. Nights from today onwards are released for resale. */
  async markNoShow(input: { propertyId: Id; reservationId: Id; userId?: Id | null; now?: Date }): Promise<Reservation> {
    const now = input.now ?? new Date();
    const property = await this.m.Property.findById(input.propertyId, { timezone: 1, organizationId: 1 }).lean();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    const today = todayIn(property.timezone, now);

    return runInTransaction(this.connection, async (session) => {
      const r = await this.m.Reservation.findOne({ _id: input.reservationId, propertyId: input.propertyId }).session(session);
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (r.status !== ReservationStatus.CONFIRMED) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.NO_SHOW);
      if (today < r.checkIn) throw new DomainValidationError('A guest can only be marked no-show from the arrival date');
      if (today < r.checkOut) await this.releaseRemainingNights(session, r, today);
      r.status = ReservationStatus.NO_SHOW;
      r.statusHistory.push({ status: ReservationStatus.NO_SHOW, at: now, by: input.userId ?? null });
      await r.save({ session });
      await this.audit.record(session, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: 'reservation.no_show',
        entityType: 'Reservation',
        entityId: r._id,
        after: { inventoryReleasedFrom: r.inventoryReleasedFrom },
      });
      return r.toObject();
    });
  }

  // ================================================================ room assignment

  /** Put a physical room on one reservation line (roomId null → Room 104). */
  async assignRoom(input: { propertyId: Id; reservationId: Id; reservationRoomId: Id; roomId: Id; userId?: Id | null }) {
    return runInTransaction(this.connection, async (session) => {
      const r = await this.m.Reservation.findOne({ _id: input.reservationId, propertyId: input.propertyId }).session(session);
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (![ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN].includes(r.status)) {
        throw new InvalidStateTransitionError('Reservation', r.status, 'ROOM_ASSIGNED');
      }
      const { previous, roomNumber } = await this.assignInSession(session, r, input.reservationRoomId, input.roomId);
      await r.save({ session });
      await this.audit.record(session, {
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: 'reservation.assign_room',
        entityType: 'Reservation',
        entityId: r._id,
        before: { roomNumber: previous },
        after: { roomNumber },
      });
      return r.toObject();
    });
  }

  /**
   * Bumping rooms.assignmentVersion inside the transaction makes concurrent
   * assignments of the same room conflict, so the overlap check that follows
   * cannot be raced (no write skew). Mutates `r`; the caller saves it.
   */
  private async assignInSession(session: ClientSession, r: HydratedDocument<Reservation>, lineId: Id, roomId: Id) {
    const line = r.reservationRooms.find((l) => l._id.equals(lineId));
    if (!line) throw new NotFoundError('Reservation room', lineId);
    if (line.quantity !== 1) throw new DomainValidationError('Split the line into single rooms before assigning');

    const room = await this.m.Room.findOneAndUpdate(
      { _id: roomId, propertyId: r.propertyId },
      { $inc: { assignmentVersion: 1 } },
      { session, new: true },
    ).lean();
    if (!room) throw new NotFoundError('Room', roomId);
    if (!room.roomTypeId.equals(line.roomTypeId)) throw new DomainValidationError('Room is of a different room type');
    if (r.reservationRooms.some((l) => !l._id.equals(line._id) && l.roomId?.equals(room._id))) {
      throw new DomainValidationError('Room is already assigned to another line of this reservation');
    }
    await this.inventory.assertRoomFree(session, { roomId: room._id, from: r.checkIn, to: r.checkOut, excludeReservationId: r._id });
    const previous = line.roomNumber;
    line.roomId = room._id;
    line.roomNumber = room.roomNumber;
    return { previous, roomNumber: room.roomNumber };
  }

  /** Release nights [from, checkOut) of every line and queue channel pushes. Mutates `r`. */
  private async releaseRemainingNights(session: ClientSession, r: HydratedDocument<Reservation>, from: Date) {
    for (const [rtId, quantity] of demandOf(r.reservationRooms)) {
      const roomTypeId = new Types.ObjectId(rtId);
      await this.inventory.release(session, { propertyId: r.propertyId, roomTypeId, checkIn: from, checkOut: r.checkOut, quantity });
      await this.syncJobs.enqueueForRoomType(session, {
        propertyId: r.propertyId,
        roomTypeId,
        types: [SyncJobType.INVENTORY],
        dateFrom: from,
        dateTo: r.checkOut,
        entityType: SyncEntityType.RESERVATION,
        entityId: r._id,
      });
    }
    r.inventoryReleasedFrom = from;
  }

  // ================================================================ internals

  private async findIdempotent(input: CreateReservationInput): Promise<Reservation | null> {
    if (input.externalReservationId) {
      return this.m.Reservation.findOne({ source: input.source, externalReservationId: input.externalReservationId }).lean();
    }
    if (input.idempotencyKey) {
      return this.m.Reservation.findOne({ propertyId: input.propertyId, idempotencyKey: input.idempotencyKey }).lean();
    }
    return null;
  }

  private priceLines(
    input: CreateReservationInput,
    property: Property,
    rtById: Map<string, RoomType>,
    rpById: Map<string, RatePlan>,
    nights: Date[],
    ctx: { isOta: boolean; isPublicDirect: boolean },
  ): Omit<ReservationRoom, '_id'>[] {
    return input.rooms.flatMap((req) => {
      const rt = rtById.get(String(req.roomTypeId));
      if (!rt) throw new NotFoundError('RoomType', req.roomTypeId);
      if (!ctx.isOta && rt.status !== RoomTypeStatus.ACTIVE) throw new DomainValidationError(`${rt.name} is not bookable`);

      const rp = req.ratePlanId ? rpById.get(String(req.ratePlanId)) : undefined;
      if (req.ratePlanId && !rp) throw new NotFoundError('RatePlan', req.ratePlanId);
      if (rp && !rp.roomTypeId.equals(rt._id)) throw new DomainValidationError(`Rate plan ${rp.code} is not for ${rt.name}`);
      if (rp && !ctx.isOta && rp.status !== RatePlanStatus.ACTIVE) throw new DomainValidationError(`Rate plan ${rp.code} is not active`);
      if (!rp && !ctx.isOta) throw new DomainValidationError('ratePlanId is required');
      if (rp && rp.currency !== property.currency) throw new DomainValidationError('Rate plan currency differs from property currency');

      let rates: number[];
      if (req.nightlyRates) {
        if (ctx.isPublicDirect) throw new DomainValidationError('Direct bookings are priced by the server');
        if (req.nightlyRates.length !== nights.length || req.nightlyRates.some((a) => !Number.isInteger(a) || a < 0)) {
          throw new DomainValidationError('nightlyRates must be one non-negative integer per night');
        }
        rates = req.nightlyRates;
      } else {
        // Flat rate-plan price. A per-date price calendar would be read here.
        rates = nights.map(() => rp?.basePrice ?? rt.basePrice);
      }

      const nightlyRates = nights.map((date, i) => ({ date, amount: rates[i] }));
      const subtotal = sum(rates);
      const tax = percentOf(subtotal, property.taxPercent);
      const line: Omit<ReservationRoom, '_id'> = {
        roomTypeId: rt._id,
        roomTypeName: rt.name,
        roomId: null,
        roomNumber: null,
        quantity: 1,
        ratePlanId: rp?._id ?? null,
        ratePlan: rp
          ? { code: rp.code, name: rp.name, type: rp.type, mealPlan: rp.mealPlan, cancellationPolicy: rp.cancellationPolicy }
          : null,
        nightlyRates,
        subtotal,
        tax,
        total: subtotal + tax,
      };
      // One line per physical room, so each can receive its own roomId later.
      return Array.from({ length: req.quantity }, () => ({ ...line }));
    });
  }

  private async assertRestrictions(session: ClientSession, propertyId: Id, roomTypeIds: Id[], checkIn: Date, checkOut: Date) {
    const rows = await this.m.Restriction.find({
      propertyId,
      roomTypeId: { $in: roomTypeIds },
      date: { $gte: checkIn, $lte: checkOut },
    })
      .session(session)
      .lean();
    const violations = roomTypeIds.flatMap((id) =>
      evaluateRestrictions(
        rows.filter((r) => r.roomTypeId.equals(id)),
        checkIn,
        checkOut,
      ),
    );
    if (violations.length) throw new RestrictionViolationError(violations);
  }

  private async resolveGuest(session: ClientSession, propertyId: Id, g: CreateReservationInput['guest']) {
    if ('guestId' in g) {
      const found = await this.m.Guest.findOne({ _id: g.guestId, propertyId }).session(session).lean();
      if (!found) throw new NotFoundError('Guest', g.guestId);
      return found;
    }
    const email = g.email?.trim().toLowerCase();
    if (email) {
      const found = await this.m.Guest.findOne({ propertyId, email }).session(session).lean();
      if (found) return found;
    }
    const [created] = await this.m.Guest.create(
      [{ propertyId, firstName: g.firstName, lastName: g.lastName ?? '', email, phone: g.phone, country: g.country }],
      { session },
    );
    return created.toObject();
  }

  /**
   * Refund due under the frozen per-line cancellation policies. Inside the
   * free window nothing is forfeited. After it, each line forfeits according
   * to its penaltyType. The guest keeps paid money above the total penalty.
   */
  policyRefund(r: Reservation, property: Property, now: Date): number {
    const netPaid = r.amountPaid - r.amountRefunded;
    if (netPaid <= 0) return 0;
    const arrival = localDateTimeToInstant(r.checkIn, property.checkInTime, property.timezone);
    const penalty = sum(
      r.reservationRooms.map((line) => {
        const p = line.ratePlan?.cancellationPolicy;
        if (!p) return 0;
        if (!p.refundable) return line.total;
        if (now.getTime() <= arrival.getTime() - p.freeCancellationHours * 3_600_000) return 0;
        switch (p.penaltyType) {
          case CancellationPenaltyType.FIRST_NIGHT: {
            const first = line.nightlyRates[0].amount * line.quantity;
            return first + Math.round((line.tax * first) / Math.max(line.subtotal, 1));
          }
          case CancellationPenaltyType.PERCENTAGE:
            return percentOf(line.total, p.penaltyValue);
          case CancellationPenaltyType.FULL_STAY:
            return line.total;
          default:
            return 0;
        }
      }),
    );
    return Math.max(0, netPaid - Math.min(penalty, r.total));
  }

  /** Spread a refund over the reservation's PAID payments, newest first, never beyond what is refundable. */
  private async createRefunds(session: ClientSession, r: Reservation, amount: number, reason: string, requestedBy: Id | null): Promise<Refund[]> {
    if (amount <= 0) return [];
    const [payments, pending] = await Promise.all([
      this.m.Payment.find({ reservationId: r._id, status: { $in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } })
        .sort({ createdAt: -1 })
        .session(session)
        .lean(),
      this.m.Refund.find({ reservationId: r._id, status: { $in: [RefundStatus.PENDING, RefundStatus.PROCESSING] } })
        .session(session)
        .lean(),
    ]);
    const pendingByPayment = new Map<string, number>();
    for (const p of pending) pendingByPayment.set(String(p.paymentId), (pendingByPayment.get(String(p.paymentId)) ?? 0) + p.amount);

    let remaining = amount;
    const docs: Partial<Refund>[] = [];
    for (const p of payments) {
      if (remaining <= 0) break;
      const refundable = p.amount - p.amountRefunded - (pendingByPayment.get(String(p._id)) ?? 0);
      const take = Math.min(refundable, remaining);
      if (take <= 0) continue;
      docs.push({
        propertyId: r.propertyId,
        reservationId: r._id,
        paymentId: p._id,
        provider: p.provider,
        amount: take,
        currency: p.currency,
        status: RefundStatus.PENDING,
        reason,
        requestedBy,
      });
      remaining -= take;
    }
    if (!docs.length) return [];
    const created = await this.m.Refund.create(docs, { session, ordered: true });
    return created.map((d) => d.toObject());
  }

  private async queueNotifications(session: ClientSession, property: Property, r: Reservation, overbookedUnits: number) {
    const docs: Record<string, unknown>[] = [
      {
        propertyId: r.propertyId,
        reservationId: r._id,
        userId: property.ownerId,
        type: NotificationType.RESERVATION_CREATED,
        channel: NotificationChannel.IN_APP,
        message: `New ${r.source} reservation ${r.reservationCode}: ${formatDateOnly(r.checkIn)} → ${formatDateOnly(r.checkOut)}`,
      },
    ];
    if (r.guest.email) {
      const confirmed = r.status === ReservationStatus.CONFIRMED;
      docs.push({
        propertyId: r.propertyId,
        reservationId: r._id,
        type: confirmed ? NotificationType.RESERVATION_CONFIRMED : NotificationType.RESERVATION_CREATED,
        channel: NotificationChannel.EMAIL,
        recipient: r.guest.email,
        subject: confirmed ? `Booking confirmed: ${r.reservationCode}` : `Complete your booking: ${r.reservationCode}`,
        message: confirmed
          ? `Your stay at ${property.name} is confirmed.`
          : `Your room at ${property.name} is held until ${r.holdExpiresAt?.toISOString()}. Complete payment to confirm.`,
      });
    }
    if (overbookedUnits > 0) {
      docs.push({
        propertyId: r.propertyId,
        reservationId: r._id,
        userId: property.ownerId,
        type: NotificationType.OVERBOOKING_ALERT,
        channel: NotificationChannel.IN_APP,
        message: `${r.source} booking ${r.externalReservationId} overbooked ${overbookedUnits} room-night(s). Relocate or upgrade the guest.`,
      });
    }
    await this.m.Notification.create(docs, { session, ordered: true });
    await this.clientEvents.emit(session, { type: 'reservation.created', property, reservation: r });
    if (r.status === ReservationStatus.CONFIRMED) await this.clientEvents.emit(session, { type: 'reservation.confirmed', property, reservation: r });
  }
}

// ---------------------------------------------------------------- helpers

function uniqueIds(ids: Id[]): Id[] {
  const seen = new Map<string, Id>();
  for (const id of ids) seen.set(String(id), new Types.ObjectId(String(id)));
  return [...seen.values()];
}

/** Rooms needed per room type, from the reservation's lines. */
export function demandOf(lines: Pick<ReservationRoom, 'roomTypeId' | 'quantity'>[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const l of lines) d.set(String(l.roomTypeId), (d.get(String(l.roomTypeId)) ?? 0) + l.quantity);
  return d;
}

export function formatMoney(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

function newReservationCode(): string {
  let s = 'TRV-';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
