import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { randomInt, randomUUID } from 'node:crypto';
import { DEFAULT_PENDING_HOLD_MINUTES, MAX_STAY_NIGHTS } from '../constants';
import { DateInput, addDays, eachNight, formatDateOnly, localDateTimeToInstant, todayIn, toDateOnly } from '../common/dates';
import { percentOf, sum } from '../common/money';
import { NightPrice, allocateGuests, baseOccupancyOf, extraGuestCharge, priceRoomNights } from '../common/pricing';
import { ChannelPaymentInfo, NO_PAYMENT_INFO, hasProviderPaymentFields, initialChannelPaymentStatus, normalizePaymentInfo } from '../common/payment-info';
import { redactSecrets } from '../common/redact';
import { evaluateRestrictions } from '../common/restrictions';
import type { GuestSnapshot, Payment, Promotion, Property, RatePlan, Refund, RoomType } from '../db-types';
import {
  CancellationPenaltyType,
  NotificationChannel,
  NotificationType,
  GLOBAL_EXTERNAL_SCOPE,
  isChannelSource,
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
  DomainError,
  DomainValidationError,
  InsufficientInventoryError,
  InvalidStateTransitionError,
  NotFoundError,
  RestrictionViolationError,
} from '../errors';
import { Db, InjectDb, isUniqueViolation, j, runInTransaction } from '../kysely';
import { NewNotification, insertNotifications } from '../repos';
import { Reservation, ReservationRoom, findReservation, insertReservation, saveReservation } from '../reservation-store';
import { d } from '../sql';
import { AuditService } from './audit.service';
import { LoadedRule, loadRateRules } from './rate-engine';
import { assertMinimumValue, assertWithinLimits, discountFor, findPromotion, recordRedemption, releaseRedemption } from './promotion';
import { ClientEventService } from './client-event.service';
import { InventoryService } from './inventory.service';
import { SyncJobService } from './sync-job.service';

type Id = string;

export type { Reservation, ReservationRoom } from '../reservation-store';

export interface CreateReservationInput {
  propertyId: Id;
  source: ReservationSource | string;
  externalReservationId?: string;
  /** Connection scope of externalReservationId for configured providers; omitted = the global scope used by built-in channels. */
  externalScope?: string;
  channelListingId?: Id | null;
  /** Direct bookings: a client-generated UUID so a retried request cannot book twice. */
  idempotencyKey?: string;
  /** Public API: the API key that created the booking, and the partner software's own reference for it (unique per property). */
  apiKeyId?: Id | null;
  partnerReference?: string;
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
  /** Manual (staff) discount in minor units. Not combinable with promotionCode. */
  discount?: number;
  /** A promotion code: validated, limited and recorded as a redemption inside the booking transaction. */
  promotionCode?: string;
  /** The total the guest was quoted. If the server-calculated total differs the booking is refused with PRICE_CHANGED. */
  expectedTotal?: number;
  specialRequests?: string;
  /**
   * What the channel or the operator's provider configuration says about who collects the money, with its provenance. Omit it when
   * nothing is known: the booking is then stored as UNKNOWN, never as paid or collected. Ignored for non-channel sources.
   */
  payment?: ChannelPaymentInfo;
  createdBy?: Id | null;
  /** Extra context for the audit log (promo code, client IP, ...). */
  auditMetadata?: Record<string, unknown>;
}

export interface CreateReservationResult {
  reservation: Reservation;
  /** False when an idempotent retry or duplicate OTA delivery returned the existing booking. */
  created: boolean;
}

const CANCELLABLE: string[] = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED];
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

/** A status-history entry as stored: ISO timestamps, ids as strings. */
const entry = (status: string, at: Date, by: string | null, reason?: string) => ({ status, at: at.toISOString(), by, ...(reason ? { reason } : {}) });

@Injectable()
export class ReservationService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly inventory: InventoryService,
    private readonly syncJobs: SyncJobService,
    private readonly audit: AuditService,
    private readonly clientEvents: ClientEventService,
  ) {}

  // ================================================================ create

  /**
   * The reservation transaction:
   *
   *   1. Idempotency short-circuit (source+externalReservationId or idempotencyKey).
   *   2. Validate property, room types, rate plans, dates, occupancy and horizon.
   *   3. Price every night from the rate plan (or accept the OTA's prices) and freeze them on the reservation.
   *   4. In ONE transaction:
   *        restrictions check → guest upsert → inventory.reserve for each room type (all nights, all-or-nothing) →
   *        insert reservation + lines → outbox rows (sync_jobs, notifications, webhook deliveries) → audit log.
   *   5. A unique violation on the external/idempotency key means a concurrent delivery won the race; return that
   *      reservation instead (its inventory decrement rolled back with this transaction).
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
    const isOta = isChannelSource(input.source);
    const isPublicDirect = input.source === ReservationSource.DIRECT || input.source === ReservationSource.TIRVONA;
    if (isOta && !input.externalReservationId) throw new DomainValidationError('externalReservationId is required for OTA bookings');

    const existing = await this.findIdempotent(input);
    if (existing) return { reservation: existing, created: false };

    // ---- reference data (read outside the transaction: it is not what we are guarding)
    const property = await this.db.selectFrom('properties').selectAll().where('id', '=', input.propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    if (!isOta && property.status !== PropertyStatus.ACTIVE) throw new DomainValidationError('Property is not accepting bookings');

    if (!isOta) {
      const today = todayIn(property.timezone);
      if (checkIn < today) throw new DomainValidationError('checkIn is in the past');
      if (checkOut > addDays(today, property.bookingHorizonDays)) {
        throw new DomainValidationError(`Bookings are open ${property.bookingHorizonDays} days ahead`);
      }
    }

    const roomTypeIds = [...new Set(input.rooms.map((r) => r.roomTypeId))];
    const ratePlanIds = [...new Set(input.rooms.flatMap((r) => (r.ratePlanId ? [r.ratePlanId] : [])))];
    const [roomTypes, ratePlans] = await Promise.all([
      this.db.selectFrom('roomTypes').selectAll().where('id', 'in', roomTypeIds).where('propertyId', '=', property.id).execute(),
      ratePlanIds.length ? this.db.selectFrom('ratePlans').selectAll().where('id', 'in', ratePlanIds).where('propertyId', '=', property.id).execute() : Promise.resolve([] as RatePlan[]),
    ]);
    const rtById = new Map(roomTypes.map((rt) => [rt.id, rt]));
    const rpById = new Map(ratePlans.map((rp) => [rp.id, rp]));

    const rules = await loadRateRules(this.db, property.id, roomTypeIds, checkIn, checkOut);
    const lines = this.priceLines(input, property, rtById, rpById, nights, { isOta, isPublicDirect }, rules);
    const demand = new Map<string, number>();
    for (const l of lines) demand.set(l.roomTypeId, (demand.get(l.roomTypeId) ?? 0) + l.quantity);

    const capacity = sum(input.rooms.map((r) => rtById.get(r.roomTypeId)!.maxOccupancy * r.quantity));
    if (!isOta && input.adults + (input.children ?? 0) > capacity) {
      throw new DomainValidationError(`Selected rooms sleep at most ${capacity} guests`);
    }

    // OTA bookings may land beyond our materialised horizon; make sure the rows exist.
    if (isOta) for (const rtId of roomTypeIds) await this.inventory.ensureInventory(property.id, rtId, checkIn, checkOut);

    const subtotal = sum(lines.map((l) => l.subtotal));
    const tax = sum(lines.map((l) => l.tax));
    let discount = input.discount ?? 0;
    let promo: Promotion | undefined;
    if (input.promotionCode) {
      if (discount) throw new DomainValidationError('Use either a promotion code or a manual discount, not both');
      const promoLines = lines.map((l) => ({ roomTypeId: l.roomTypeId, total: l.total }));
      promo = await findPromotion(this.db, property.id, input.promotionCode, checkIn, checkOut);
      assertMinimumValue(promo, promoLines);
      await assertWithinLimits(this.db, promo); // fail fast; the binding check runs under a row lock in the transaction
      discount = discountFor(promo, promoLines);
    }
    if (!Number.isInteger(discount) || discount < 0 || discount > subtotal + tax) throw new DomainValidationError('Invalid discount');
    if (input.expectedTotal !== undefined && input.expectedTotal !== subtotal + tax - discount) {
      throw new DomainError('PRICE_CHANGED', 'The price changed since it was quoted. Review the new total and confirm again.', { expectedTotal: input.expectedTotal, total: subtotal + tax - discount, currency: property.currency });
    }

    const status = input.status ?? (isPublicDirect ? ReservationStatus.PENDING : ReservationStatus.CONFIRMED);
    const paymentInfo = isOta ? normalizePaymentInfo(input.payment) : { ...NO_PAYMENT_INFO };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await runInTransaction(this.db, async (tx) => {
          if (!isOta) await this.assertRestrictions(tx, property.id, roomTypeIds, checkIn, checkOut);

          const guest = await this.resolveGuest(tx, property.id, input.guest);
          if (promo) {
            // Row lock on the promotion: concurrent redemptions queue here, so the limits cannot be exceeded by a race.
            const locked = await findPromotion(tx, property.id, input.promotionCode!, checkIn, checkOut, true);
            await assertWithinLimits(tx, locked, guest.id);
            if (discountFor(locked, lines.map((l) => ({ roomTypeId: l.roomTypeId, total: l.total }))) !== discount) {
              throw new DomainError('PRICE_CHANGED', 'The promotion changed while you were booking. Review the new total and confirm again.');
            }
          }

          let overbookedUnits = 0;
          for (const [rtId, quantity] of demand) {
            const r = await this.inventory.reserve(tx, { propertyId: property.id, roomTypeId: rtId, checkIn, checkOut, quantity, allowOverbooking: isOta });
            overbookedUnits += r.overbookedUnits;
          }

          const now = new Date();
          const doc = await insertReservation(
            tx,
            {
              propertyId: property.id,
              reservationCode: newReservationCode(),
              source: input.source,
              externalReservationId: input.externalReservationId ?? null,
              ...(input.externalScope ? { externalScope: input.externalScope } : {}),
              channelListingId: input.channelListingId ?? null,
              idempotencyKey: input.idempotencyKey ?? null,
              apiKeyId: input.apiKeyId ?? null,
              partnerReference: input.partnerReference ?? null,
              status,
              guestId: guest.id,
              guest: j({ firstName: guest.firstName, lastName: guest.lastName, email: guest.email ?? undefined, phone: guest.phone ?? undefined }),
              checkIn: formatDateOnly(checkIn),
              checkOut: formatDateOnly(checkOut),
              nights: nights.length,
              adults: input.adults,
              children: input.children ?? 0,
              specialRequests: input.specialRequests ?? null,
              subtotal,
              tax,
              discount,
              total: subtotal + tax - discount,
              currency: property.currency,
              paymentStatus: isOta ? (initialChannelPaymentStatus(paymentInfo) as ReservationPaymentStatus) : ReservationPaymentStatus.UNPAID,
              ...paymentInfo,
              holdExpiresAt: status === ReservationStatus.PENDING ? new Date(now.getTime() + DEFAULT_PENDING_HOLD_MINUTES * 60_000) : null,
              overbooked: overbookedUnits > 0,
              inventoryReleasedFrom: null,
              checkedInAt: null,
              checkedOutAt: null,
              statusHistory: j([entry(status, now, input.createdBy ?? null)]),
              cancelledAt: null,
              cancellationReason: null,
              createdBy: input.createdBy ?? null,
            },
            lines,
          );

          if (promo) await recordRedemption(tx, promo.id, doc.id, guest.id, discount);
          for (const rtId of demand.keys()) {
            await this.syncJobs.enqueueForRoomType(tx, {
              propertyId: property.id,
              roomTypeId: rtId,
              types: [SyncJobType.INVENTORY],
              dateFrom: checkIn,
              dateTo: checkOut,
              entityType: SyncEntityType.RESERVATION,
              entityId: doc.id,
            });
          }
          await this.queueNotifications(tx, property, doc, overbookedUnits);
          await this.audit.record(tx, {
            organizationId: property.organizationId,
            propertyId: property.id,
            userId: input.createdBy ?? null,
            action: 'reservation.create',
            entityType: 'Reservation',
            entityId: doc.id,
            after: { reservationCode: doc.reservationCode, status, source: input.source, checkIn, checkOut, total: doc.total },
            metadata: { ...(input.auditMetadata ?? {}), ...(overbookedUnits ? { overbookedUnits } : {}) },
          });
          return { reservation: doc, created: true };
        });
      } catch (err) {
        // A concurrent identical request may have taken the last rooms: if it created THIS booking, replay it.
        if (err instanceof InsufficientInventoryError) {
          const winner = await this.findIdempotent(input);
          if (winner) return { reservation: winner, created: false };
          throw err;
        }
        if (!isUniqueViolation(err)) throw err;
        if ((err as { constraint?: string }).constraint === 'reservations_code_key') continue; // 1-in-10^12 code collision: new code, new attempt
        const winner = await this.findIdempotent(input);
        if (winner) return { reservation: winner, created: false };
        throw err;
      }
    }
    throw new Error('Could not allocate a unique reservation code');
  }

  // ================================================================ cancel

  /**
   * The cancellation transaction: lock the reservation, flip status (PENDING|CONFIRMED → CANCELLED), release every night
   * of every room, create PENDING refund rows per the frozen cancellation policy, outbox (sync_jobs, notification,
   * webhook delivery), audit. Cancelling an already-cancelled reservation is a no-op that returns it, because OTAs
   * re-send cancellations.
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
    const property = await this.db.selectFrom('properties').selectAll().where('id', '=', input.propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', input.propertyId);

    return runInTransaction(this.db, async (tx) => {
      // The row lock makes concurrent cancels queue: exactly one of them releases inventory.
      const r = await findReservation(tx, { id: input.reservationId, propertyId: input.propertyId }, { forUpdate: true });
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (r.status === ReservationStatus.CANCELLED) return { reservation: r, refunds: [], alreadyCancelled: true };
      if (!CANCELLABLE.includes(r.status)) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.CANCELLED);

      const flip = await tx
        .updateTable('reservations')
        .set({
          status: ReservationStatus.CANCELLED,
          cancelledAt: now,
          cancellationReason: input.reason,
          holdExpiresAt: null,
          inventoryReleasedFrom: formatDateOnly(r.checkIn),
          statusHistory: sql<string>`status_history || ${j([entry(ReservationStatus.CANCELLED, now, input.cancelledBy ?? null, input.reason)])}::jsonb`,
        })
        .where('id', '=', r.id)
        .where('status', 'in', CANCELLABLE)
        .executeTakeFirst();
      if (Number(flip.numUpdatedRows) !== 1) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.CANCELLED);
      const flipped = (await findReservation(tx, { id: r.id }))!;

      for (const [rtId, quantity] of demandOf(r.reservationRooms)) {
        await this.inventory.release(tx, { propertyId: r.propertyId, roomTypeId: rtId, checkIn: r.checkIn, checkOut: r.checkOut, quantity });
      }
      await releaseRedemption(tx, r.id, now); // a cancelled booking or an expired hold gives its promotion use back

      const refunds =
        r.paymentStatus === ReservationPaymentStatus.CHANNEL_COLLECTED
          ? [] // no refund is created HERE: the channel is responsible for collection, so it owns any refund. That a refund happened is NOT recorded (it is not known)
          : await this.createRefunds(tx, r, input.refundAmount ?? this.policyRefund(r, property, now), input.reason, input.cancelledBy ?? null);

      for (const [rtId] of demandOf(r.reservationRooms)) {
        await this.syncJobs.enqueueForRoomType(tx, {
          propertyId: r.propertyId,
          roomTypeId: rtId,
          types: [SyncJobType.INVENTORY],
          dateFrom: r.checkIn,
          dateTo: r.checkOut,
          entityType: SyncEntityType.RESERVATION,
          entityId: r.id,
        });
      }
      if (r.guest.email) {
        await insertNotifications(tx, [
          {
            propertyId: r.propertyId,
            reservationId: r.id,
            type: NotificationType.RESERVATION_CANCELLED,
            channel: NotificationChannel.EMAIL,
            recipient: r.guest.email,
            subject: `Reservation ${r.reservationCode} cancelled`,
            message: `Your reservation ${r.reservationCode} at ${property.name} has been cancelled.`,
            metadata: { refundTotal: sum(refunds.map((x) => x.amount)) },
          },
        ]);
      }
      await this.audit.record(tx, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.cancelledBy ?? null,
        action: 'reservation.cancel',
        entityType: 'Reservation',
        entityId: r.id,
        before: { status: r.status },
        after: { status: ReservationStatus.CANCELLED, reason: input.reason, refunds: refunds.map((x) => x.amount) },
      });
      await this.clientEvents.emit(tx, { type: 'reservation.cancelled', property, reservation: flipped });
      return { reservation: flipped, refunds, alreadyCancelled: false };
    });
  }

  /** OTA cancellations arrive with the channel's ID, not ours. */
  async cancelByExternalId(source: string, externalReservationId: string, reason: string, externalScope: string = GLOBAL_EXTERNAL_SCOPE) {
    const r = await this.db.selectFrom('reservations').select(['id', 'propertyId']).where('source', '=', source).where('externalScope', '=', externalScope).where('externalReservationId', '=', externalReservationId).executeTakeFirst();
    if (!r) throw new NotFoundError(`${source} reservation`, externalReservationId);
    return this.cancelReservation({ propertyId: r.propertyId, reservationId: r.id, reason });
  }

  /** Scheduled sweeper: release inventory held by unpaid PENDING bookings whose hold expired. */
  async expirePendingHolds(now = new Date(), batch = 100): Promise<number> {
    const due = await this.db
      .selectFrom('reservations')
      .select(['id', 'propertyId'])
      .where('status', '=', ReservationStatus.PENDING)
      .where('holdExpiresAt', 'is not', null)
      .where('holdExpiresAt', '<=', now)
      .orderBy('holdExpiresAt')
      .limit(batch)
      .execute();
    let expired = 0;
    for (const r of due) {
      try {
        const res = await this.cancelReservation({ propertyId: r.propertyId, reservationId: r.id, reason: 'Payment hold expired', now });
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
   * Record a captured payment (cash, bank transfer, or a verified gateway payment without a prior order row). This is
   * idempotent on provider+providerPaymentId. See applyCapturedPayment for the effects on the reservation.
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
    const findDup = () =>
      this.db.selectFrom('payments').selectAll().where('provider', '=', input.provider).where('providerPaymentId', '=', input.providerPaymentId!).executeTakeFirst();
    if (input.providerPaymentId) {
      const dup = await findDup();
      if (dup) return { payment: dup, duplicate: true };
    }
    try {
      return await runInTransaction(this.db, async (tx) => {
        const r = await findReservation(tx, { id: input.reservationId, propertyId: input.propertyId }, { forUpdate: true });
        if (!r) throw new NotFoundError('Reservation', input.reservationId);
        if (r.currency !== input.currency) throw new DomainValidationError(`Payment currency must be ${r.currency}`);

        const now = new Date();
        const payment = await tx
          .insertInto('payments')
          .values({
            propertyId: r.propertyId,
            reservationId: r.id,
            provider: input.provider,
            providerPaymentId: input.providerPaymentId ?? null,
            providerOrderId: input.providerOrderId ?? null,
            amount: input.amount,
            currency: input.currency,
            status: input.status,
            paidAt: input.status === PaymentStatus.PAID ? now : null,
            failureReason: null,
            metadata: j(redactSecrets(JSON.parse(JSON.stringify(input.metadata ?? {})))),
            createdBy: input.createdBy ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const confirmed = input.status === PaymentStatus.PAID ? (await this.applyCapturedPayment(tx, r, input.amount, now)).confirmed : false;
        await this.audit.record(tx, {
          propertyId: r.propertyId,
          userId: input.createdBy ?? null,
          action: 'payment.record',
          entityType: 'Payment',
          entityId: payment.id,
          after: { reservationId: r.id, amount: input.amount, provider: input.provider, status: input.status, confirmed },
        });
        return { payment, duplicate: false };
      });
    } catch (err) {
      if (isUniqueViolation(err) && input.providerPaymentId) {
        const dup = await findDup();
        if (dup) return { payment: dup, duplicate: true };
      }
      throw err;
    }
  }

  /**
   * Effects of money arriving, inside the caller's transaction. The payment row must already be PAID in the same
   * transaction. It raises amountPaid and paymentStatus, confirms a PENDING booking (ending its hold), and queues guest
   * notifications. If the booking was cancelled first (the hold expired while the guest was paying), the money is queued
   * straight back as a refund.
   */
  async applyCapturedPayment(tx: Db, r: Reservation, amount: number, now = new Date()): Promise<{ confirmed: boolean }> {
    const amountPaid = r.amountPaid + amount;
    const paymentStatus = amountPaid >= r.total ? ReservationPaymentStatus.PAID : ReservationPaymentStatus.PARTIALLY_PAID;
    const confirm = r.status === ReservationStatus.PENDING;
    const wasPaid = r.amountPaid;
    await tx
      .updateTable('reservations')
      .set({
        amountPaid,
        paymentStatus,
        ...(confirm
          ? {
              status: ReservationStatus.CONFIRMED,
              holdExpiresAt: null,
              statusHistory: sql<string>`status_history || ${j([entry(ReservationStatus.CONFIRMED, now, null, 'Payment received')])}::jsonb`,
            }
          : {}),
      })
      .where('id', '=', r.id)
      .execute();
    const notifications: NewNotification[] = [];
    if (r.guest.email) {
      notifications.push({
        propertyId: r.propertyId,
        reservationId: r.id,
        type: NotificationType.PAYMENT_SUCCESS,
        channel: NotificationChannel.EMAIL,
        recipient: r.guest.email,
        subject: `Payment received for ${r.reservationCode}`,
        message: `We received your payment of ${formatMoney(amount, r.currency)} for reservation ${r.reservationCode}.`,
      });
      if (confirm) {
        notifications.push({
          propertyId: r.propertyId,
          reservationId: r.id,
          type: NotificationType.RESERVATION_CONFIRMED,
          channel: NotificationChannel.EMAIL,
          recipient: r.guest.email,
          subject: `Booking confirmed: ${r.reservationCode}`,
          message: `Your reservation ${r.reservationCode} is confirmed.`,
        });
      }
    }
    if (notifications.length) await insertNotifications(tx, notifications);
    const eventProperty = await tx.selectFrom('properties').select(['id', 'organizationId', 'slug', 'name']).where('id', '=', r.propertyId).executeTakeFirst();
    if (eventProperty) {
      const after: Reservation = { ...r, amountPaid, paymentStatus, ...(confirm ? { status: ReservationStatus.CONFIRMED, holdExpiresAt: null } : {}) };
      const payment = { amount, currency: r.currency, totalPaid: amountPaid };
      // The previous amountPaid makes the id unique per payment while staying stable if this transaction is retried.
      await this.clientEvents.emit(tx, { type: 'payment.succeeded', property: eventProperty, reservation: after, discriminator: String(wasPaid), extra: { payment } });
      if (confirm) await this.clientEvents.emit(tx, { type: 'reservation.confirmed', property: eventProperty, reservation: after });
    }
    if (r.status === ReservationStatus.CANCELLED) {
      await this.createRefunds(tx, r, amount, 'Payment received after cancellation', null);
    }
    return { confirmed: confirm };
  }

  // ================================================================ updates & date changes

  /**
   * PATCH semantics. Contact and notes changes are a plain update. A date change runs as ONE transaction: release every
   * old night → reserve every new night (all-or-nothing, same guard as a new booking) → re-price. Nights kept from the
   * old stay keep their frozen price; new nights get the rate plan's current price (or the OTA's price) → re-check
   * physical room assignments → outbox + audit.
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
    const property = await this.db.selectFrom('properties').selectAll().where('id', '=', input.propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    const current = await findReservation(this.db, { id: input.reservationId, propertyId: input.propertyId });
    if (!current) throw new NotFoundError('Reservation', input.reservationId);
    const isOta = isChannelSource(current.source);
    const newIn = input.checkIn ? toDateOnly(input.checkIn) : current.checkIn;
    const newOut = input.checkOut ? toDateOnly(input.checkOut) : current.checkOut;
    const datesChanged = newIn.getTime() !== current.checkIn.getTime() || newOut.getTime() !== current.checkOut.getTime();
    const nights = eachNight(newIn, newOut);
    if (nights.length < 1) throw new DomainValidationError('checkOut must be after checkIn');
    if (nights.length > MAX_STAY_NIGHTS) throw new DomainValidationError(`Stays are limited to ${MAX_STAY_NIGHTS} nights`);
    if (datesChanged && isOta) {
      for (const rtId of demandOf(current.reservationRooms).keys()) {
        await this.inventory.ensureInventory(current.propertyId, rtId, newIn, newOut);
      }
    }

    return runInTransaction(this.db, async (tx) => {
      const r = await findReservation(tx, { id: input.reservationId, propertyId: input.propertyId }, { forUpdate: true });
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      const editable: string[] = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN];
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
          await this.inventory.release(tx, { propertyId: r.propertyId, roomTypeId: rtId, checkIn: r.checkIn, checkOut: r.checkOut, quantity });
        }
        let overbookedUnits = 0;
        for (const [rtId, quantity] of demand) {
          const res = await this.inventory.reserve(tx, { propertyId: r.propertyId, roomTypeId: rtId, checkIn: newIn, checkOut: newOut, quantity, allowOverbooking: isOta });
          overbookedUnits += res.overbookedUnits;
        }

        const planIds = r.reservationRooms.flatMap((l) => (l.ratePlanId ? [l.ratePlanId] : []));
        const ratePlans = planIds.length ? await tx.selectFrom('ratePlans').select(['id', 'basePrice']).where('id', 'in', planIds).execute() : [];
        const rpById = new Map(ratePlans.map((rp) => [rp.id, rp]));
        // Nights that stay keep the price they were sold at. Nights that are new are priced today, by the same rules as a new booking.
        const pricer = isOta ? undefined : await this.linePricer(tx, r, newIn, newOut, input.adults ?? r.adults, input.children ?? r.children);
        for (const [i, line] of r.reservationRooms.entries()) {
          const old = new Map(line.nightlyRates.map((n) => [n.date, n]));
          const fallback = line.nightlyRates[line.nightlyRates.length - 1]?.amount ?? 0;
          const provided = input.nightlyRatesByLine?.[i];
          if (provided && provided.length !== nights.length) throw new DomainValidationError('nightlyRatesByLine must have one price per night');
          const planPrice = line.ratePlanId ? rpById.get(line.ratePlanId)?.basePrice : undefined;
          line.nightlyRates = nights.map((night, k): NightPrice | { date: string; amount: number } => {
            const date = formatDateOnly(night);
            if (provided?.[k] !== undefined) return { date, amount: provided[k] };
            const kept = old.get(date);
            if (kept) return kept;
            return pricer?.price(i, night, planPrice) ?? { date, amount: planPrice ?? fallback };
          });
          line.subtotal = sum(line.nightlyRates.map((n) => n.amount)) * line.quantity;
          line.tax = percentOf(line.subtotal, property.taxPercent);
          line.total = line.subtotal + line.tax;

          if (line.roomId) {
            await tx.updateTable('rooms').set({ assignmentVersion: sql`assignment_version + 1` }).where('id', '=', line.roomId).execute();
            try {
              await this.inventory.assertRoomFree(tx, { roomId: line.roomId, from: newIn, to: newOut, excludeReservationId: r.id });
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
        this.retotal(r);
        if (overbookedUnits) r.overbooked = true;
      }

      if (input.adults !== undefined) r.adults = input.adults;
      if (input.children !== undefined) r.children = input.children;
      if (!isOta && (input.adults !== undefined || input.children !== undefined)) {
        const typeIds = [...demandOf(r.reservationRooms).keys()];
        const types = await tx.selectFrom('roomTypes').select(['id', 'maxOccupancy']).where('id', 'in', typeIds).execute();
        const cap = new Map(types.map((t) => [t.id, t.maxOccupancy]));
        const capacity = sum(r.reservationRooms.map((l) => (cap.get(l.roomTypeId) ?? 0) * l.quantity));
        if (r.adults + r.children > capacity) throw new DomainValidationError(`Rooms on this reservation sleep at most ${capacity} guests`);
        // Extra-guest charges follow the party. Rates the stay was sold at are untouched.
        const totalBefore = r.total;
        const pricer = await this.linePricer(tx, r, r.checkIn, r.checkOut, r.adults, r.children);
        if (pricer) {
          for (const [i, line] of r.reservationRooms.entries()) {
            const extra = extraGuestCharge(pricer.party[i], pricer.terms(line.roomTypeId));
            line.nightlyRates = line.nightlyRates.map((n) => {
              const rate = n.rate ?? n.amount - (n.extra ?? 0);
              return { ...n, rate, extra, amount: rate + extra };
            });
            line.subtotal = sum(line.nightlyRates.map((n) => n.amount)) * line.quantity;
            line.tax = percentOf(line.subtotal, property.taxPercent);
            line.total = line.subtotal + line.tax;
          }
          this.retotal(r);
          if (r.total !== totalBefore && r.status === ReservationStatus.PENDING) {
            throw new DomainValidationError('This change alters the price while the booking is waiting for payment. Complete or cancel the payment first.');
          }
        }
      }
      if (input.specialRequests !== undefined) r.specialRequests = input.specialRequests;
      if (input.guest) {
        for (const k of ['firstName', 'lastName', 'email', 'phone'] as const) {
          if (input.guest[k] !== undefined) (r.guest as unknown as Record<string, unknown>)[k] = input.guest[k];
        }
      }
      await saveReservation(tx, r);

      if (datesChanged) {
        const from = new Date(Math.min(before.checkIn.getTime(), newIn.getTime()));
        const to = new Date(Math.max(before.checkOut.getTime(), newOut.getTime()));
        for (const rtId of demandOf(r.reservationRooms).keys()) {
          await this.syncJobs.enqueueForRoomType(tx, {
            propertyId: r.propertyId,
            roomTypeId: rtId,
            types: [SyncJobType.INVENTORY],
            dateFrom: from,
            dateTo: to,
            entityType: SyncEntityType.RESERVATION,
            entityId: r.id,
          });
        }
      }
      await this.audit.record(tx, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: datesChanged ? 'reservation.modify_dates' : 'reservation.update',
        entityType: 'Reservation',
        entityId: r.id,
        before,
        after: { checkIn: r.checkIn, checkOut: r.checkOut, adults: r.adults, children: r.children, total: r.total },
      });
      await this.emitUpdated(tx, r, datesChanged ? 'dates' : 'details');
      return r;
    });
  }

  /**
   * Records what a provider reported about a booking's money (status, payout, commission, net amount). Read-only visibility: it never
   * changes amounts paid, refunds or the booking's status. A collection model is only filled in when none is known yet; it is never
   * replaced. Returns false when the event carried nothing to record or the booking does not exist.
   */
  async refreshChannelPaymentInfo(source: string, externalReservationId: string, externalScope: string, info: ChannelPaymentInfo | undefined, now = new Date()): Promise<boolean> {
    if (!isChannelSource(source)) return false;
    const cols = normalizePaymentInfo(info, now);
    const provider = hasProviderPaymentFields(cols);
    if (!provider && !cols.collectionModel) return false;
    const r = await this.db
      .selectFrom('reservations')
      .select(['id', 'paymentStatus', 'collectionModel'])
      .where('source', '=', source)
      .where('externalScope', '=', externalScope)
      .where('externalReservationId', '=', externalReservationId)
      .executeTakeFirst();
    if (!r) return false;
    const set: Record<string, unknown> = {};
    if (provider) {
      Object.assign(set, {
        providerPaymentStatusRaw: cols.providerPaymentStatusRaw,
        providerPaymentStatus: cols.providerPaymentStatus,
        payoutStatusRaw: cols.payoutStatusRaw,
        payoutStatus: cols.payoutStatus,
        payoutDate: cols.payoutDate,
        commissionAmount: cols.commissionAmount,
        netAmount: cols.netAmount,
        paymentInfoUpdatedAt: now,
      });
    }
    if (r.collectionModel === null && cols.collectionModel && r.paymentStatus === ReservationPaymentStatus.UNKNOWN) {
      Object.assign(set, { collectionModel: cols.collectionModel, collectionSource: cols.collectionSource, paymentStatus: initialChannelPaymentStatus(cols) });
    }
    await this.db.updateTable('reservations').set(set).where('id', '=', r.id).execute();
    return true;
  }

  /** OTA modifications arrive with the channel's ID. */
  async modifyByExternalId(
    source: string,
    externalReservationId: string,
    changes: Omit<Parameters<ReservationService['updateReservation']>[0], 'propertyId' | 'reservationId'>,
    externalScope: string = GLOBAL_EXTERNAL_SCOPE,
  ) {
    const r = await this.db.selectFrom('reservations').select(['id', 'propertyId']).where('source', '=', source).where('externalScope', '=', externalScope).where('externalReservationId', '=', externalReservationId).executeTakeFirst();
    if (!r) throw new NotFoundError(`${source} reservation`, externalReservationId);
    return this.updateReservation({ ...changes, propertyId: r.propertyId, reservationId: r.id });
  }

  // ================================================================ front desk

  /**
   * CONFIRMED → CHECKED_IN. Optional room assignments are applied first, every line must end up with a room, and each
   * room must be AVAILABLE (clean). It becomes OCCUPIED through a conditional update, so two desks cannot put guests
   * into the same room.
   */
  async checkIn(input: {
    propertyId: Id;
    reservationId: Id;
    assignments?: { reservationRoomId: Id; roomId: Id }[];
    userId?: Id | null;
    now?: Date;
  }): Promise<Reservation> {
    const now = input.now ?? new Date();
    const property = await this.db.selectFrom('properties').select(['timezone', 'organizationId']).where('id', '=', input.propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    const today = todayIn(property.timezone, now);

    return runInTransaction(this.db, async (tx) => {
      const r = await findReservation(tx, { id: input.reservationId, propertyId: input.propertyId }, { forUpdate: true });
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (r.status !== ReservationStatus.CONFIRMED) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.CHECKED_IN);
      if (today < r.checkIn) throw new DomainValidationError(`Check-in opens on ${formatDateOnly(r.checkIn)}`);
      if (today >= r.checkOut) throw new DomainValidationError('This stay has already ended');

      for (const a of input.assignments ?? []) await this.assignInTx(tx, r, a.reservationRoomId, a.roomId);
      const unassigned = r.reservationRooms.filter((l) => !l.roomId);
      if (unassigned.length) throw new DomainValidationError('Assign a room to every line before check-in', { lines: unassigned.map((l) => l.id) });

      for (const line of r.reservationRooms) {
        const res = await tx.updateTable('rooms').set({ status: RoomStatus.OCCUPIED }).where('id', '=', line.roomId!).where('status', '=', RoomStatus.AVAILABLE).executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) {
          throw new ConflictError('ROOM_NOT_READY', `Room ${line.roomNumber} is not ready (it must be AVAILABLE)`, { roomId: line.roomId });
        }
      }
      r.status = ReservationStatus.CHECKED_IN;
      r.checkedInAt = now;
      r.statusHistory = [...r.statusHistory, entry(ReservationStatus.CHECKED_IN, now, input.userId ?? null)];
      await saveReservation(tx, r);
      await this.audit.record(tx, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: 'reservation.check_in',
        entityType: 'Reservation',
        entityId: r.id,
        after: { rooms: r.reservationRooms.map((l) => l.roomNumber) },
      });
      await this.emitUpdated(tx, r, 'check_in');
      return r;
    });
  }

  /**
   * CHECKED_IN → CHECKED_OUT. Rooms go to CLEANING. On an early departure the unused nights [today, checkOut) go back to
   * inventory and are pushed to channels. Charges are not changed automatically; `balanceDue` is returned.
   */
  async checkOut(input: { propertyId: Id; reservationId: Id; userId?: Id | null; now?: Date }): Promise<{ reservation: Reservation; balanceDue: number }> {
    const now = input.now ?? new Date();
    const property = await this.db.selectFrom('properties').select(['timezone', 'organizationId']).where('id', '=', input.propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    const today = todayIn(property.timezone, now);

    return runInTransaction(this.db, async (tx) => {
      const r = await findReservation(tx, { id: input.reservationId, propertyId: input.propertyId }, { forUpdate: true });
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (r.status !== ReservationStatus.CHECKED_IN) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.CHECKED_OUT);

      for (const line of r.reservationRooms) {
        if (line.roomId) await tx.updateTable('rooms').set({ status: RoomStatus.CLEANING }).where('id', '=', line.roomId).where('status', '=', RoomStatus.OCCUPIED).execute();
      }
      if (today < r.checkOut) await this.releaseRemainingNights(tx, r, today > r.checkIn ? today : r.checkIn);
      r.status = ReservationStatus.CHECKED_OUT;
      r.checkedOutAt = now;
      r.statusHistory = [...r.statusHistory, entry(ReservationStatus.CHECKED_OUT, now, input.userId ?? null)];
      await saveReservation(tx, r);
      await this.audit.record(tx, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: 'reservation.check_out',
        entityType: 'Reservation',
        entityId: r.id,
        after: { early: today < r.checkOut, inventoryReleasedFrom: r.inventoryReleasedFrom },
      });
      await this.emitUpdated(tx, r, 'check_out');
      return { reservation: r, balanceDue: Math.max(0, r.total - (r.amountPaid - r.amountRefunded)) };
    });
  }

  /** CONFIRMED → NO_SHOW, from the arrival date on. Nights from today onwards are released for resale. */
  async markNoShow(input: { propertyId: Id; reservationId: Id; userId?: Id | null; now?: Date }): Promise<Reservation> {
    const now = input.now ?? new Date();
    const property = await this.db.selectFrom('properties').select(['timezone', 'organizationId']).where('id', '=', input.propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', input.propertyId);
    const today = todayIn(property.timezone, now);

    return runInTransaction(this.db, async (tx) => {
      const r = await findReservation(tx, { id: input.reservationId, propertyId: input.propertyId }, { forUpdate: true });
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      if (r.status !== ReservationStatus.CONFIRMED) throw new InvalidStateTransitionError('Reservation', r.status, ReservationStatus.NO_SHOW);
      if (today < r.checkIn) throw new DomainValidationError('A guest can only be marked no-show from the arrival date');
      if (today < r.checkOut) await this.releaseRemainingNights(tx, r, today);
      r.status = ReservationStatus.NO_SHOW;
      r.statusHistory = [...r.statusHistory, entry(ReservationStatus.NO_SHOW, now, input.userId ?? null)];
      await saveReservation(tx, r);
      await this.audit.record(tx, {
        organizationId: property.organizationId,
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: 'reservation.no_show',
        entityType: 'Reservation',
        entityId: r.id,
        after: { inventoryReleasedFrom: r.inventoryReleasedFrom },
      });
      await this.emitUpdated(tx, r, 'no_show');
      return r;
    });
  }

  // ================================================================ room assignment

  /** Put a physical room on one reservation line (roomId null → Room 104). */
  async assignRoom(input: { propertyId: Id; reservationId: Id; reservationRoomId: Id; roomId: Id; userId?: Id | null }) {
    return runInTransaction(this.db, async (tx) => {
      const r = await findReservation(tx, { id: input.reservationId, propertyId: input.propertyId }, { forUpdate: true });
      if (!r) throw new NotFoundError('Reservation', input.reservationId);
      const allowed: string[] = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN];
      if (!allowed.includes(r.status)) throw new InvalidStateTransitionError('Reservation', r.status, 'ROOM_ASSIGNED');
      const { previous, roomNumber } = await this.assignInTx(tx, r, input.reservationRoomId, input.roomId);
      await saveReservation(tx, r);
      await this.audit.record(tx, {
        propertyId: r.propertyId,
        userId: input.userId ?? null,
        action: 'reservation.assign_room',
        entityType: 'Reservation',
        entityId: r.id,
        before: { roomNumber: previous },
        after: { roomNumber },
      });
      await this.emitUpdated(tx, r, 'room_assigned');
      return r;
    });
  }

  /**
   * Bumping rooms.assignment_version inside the transaction takes a row lock on the room, so concurrent assignments of
   * the same room queue and the overlap check that follows cannot be raced (no write skew). Mutates `r`; the caller
   * saves it.
   */
  private async assignInTx(tx: Db, r: Reservation, lineId: Id, roomId: Id) {
    const line = r.reservationRooms.find((l) => l.id === lineId);
    if (!line) throw new NotFoundError('Reservation room', lineId);
    if (line.quantity !== 1) throw new DomainValidationError('Split the line into single rooms before assigning');

    const room = await tx
      .updateTable('rooms')
      .set({ assignmentVersion: sql`assignment_version + 1` })
      .where('id', '=', roomId)
      .where('propertyId', '=', r.propertyId)
      .returning(['id', 'roomTypeId', 'roomNumber', 'status'])
      .executeTakeFirst();
    if (!room) throw new NotFoundError('Room', roomId);
    if (room.status === RoomStatus.RETIRED) throw new DomainValidationError('Room is retired and cannot be assigned');
    if (room.roomTypeId !== line.roomTypeId) throw new DomainValidationError('Room is of a different room type');
    if (r.reservationRooms.some((l) => l.id !== line.id && l.roomId === room.id)) {
      throw new DomainValidationError('Room is already assigned to another line of this reservation');
    }
    await this.inventory.assertRoomFree(tx, { roomId: room.id, from: r.checkIn, to: r.checkOut, excludeReservationId: r.id });
    const previous = line.roomNumber;
    line.roomId = room.id;
    line.roomNumber = room.roomNumber;
    return { previous, roomNumber: room.roomNumber };
  }

  /** Release nights [from, checkOut) of every line and queue channel pushes. Mutates `r`. */
  private async releaseRemainingNights(tx: Db, r: Reservation, from: Date) {
    for (const [rtId, quantity] of demandOf(r.reservationRooms)) {
      await this.inventory.release(tx, { propertyId: r.propertyId, roomTypeId: rtId, checkIn: from, checkOut: r.checkOut, quantity });
      await this.syncJobs.enqueueForRoomType(tx, {
        propertyId: r.propertyId,
        roomTypeId: rtId,
        types: [SyncJobType.INVENTORY],
        dateFrom: from,
        dateTo: r.checkOut,
        entityType: SyncEntityType.RESERVATION,
        entityId: r.id,
      });
    }
    r.inventoryReleasedFrom = from;
  }

  // ================================================================ internals

  /** `reservation.updated` for a change after booking (dates, details, room assignment, check-in/out, no-show). `change` says which. */
  private async emitUpdated(tx: Db, r: Reservation, change: 'dates' | 'details' | 'room_assigned' | 'check_in' | 'check_out' | 'no_show') {
    const property = await tx.selectFrom('properties').select(['id', 'organizationId', 'slug', 'name']).where('id', '=', r.propertyId).executeTakeFirstOrThrow();
    // A fresh id per update: two edits of one reservation are two events. The unique (endpoint, event id) constraint still
    // makes a repeated insert of the SAME event a no-op.
    await this.clientEvents.emit(tx, { type: 'reservation.updated', property, reservation: r, discriminator: `${change}:${randomUUID()}`, extra: { change } });
  }

  /** Recomputes the reservation totals from its lines. The discount can never exceed what is left to pay for. */
  private retotal(r: Reservation) {
    r.subtotal = sum(r.reservationRooms.map((l) => l.subtotal));
    r.tax = sum(r.reservationRooms.map((l) => l.tax));
    r.discount = Math.min(r.discount, r.subtotal + r.tax);
    r.total = r.subtotal + r.tax - r.discount;
    if (r.paymentStatus !== ReservationPaymentStatus.CHANNEL_COLLECTED && r.amountPaid > 0) {
      r.paymentStatus = r.amountPaid >= r.total ? ReservationPaymentStatus.PAID : ReservationPaymentStatus.PARTIALLY_PAID;
    }
  }

  /**
   * Prices nights of an existing, server-priced reservation with today's rules and its current party. Undefined when the
   * reservation cannot be re-priced by rules (a line holds several rooms, as some OTA imports do).
   */
  private async linePricer(tx: Db, r: Reservation, from: Date, to: Date, adults: number, children: number) {
    if (isChannelSource(r.source) || r.reservationRooms.some((l) => l.quantity !== 1)) return undefined;
    const typeIds = [...new Set(r.reservationRooms.map((l) => l.roomTypeId))];
    const types = new Map((await tx.selectFrom('roomTypes').selectAll().where('id', 'in', typeIds).execute()).map((t) => [t.id, t]));
    const rules = await loadRateRules(tx, r.propertyId, typeIds, from, to);
    const party = allocateGuests(
      r.reservationRooms.map((l) => ({ baseOccupancy: baseOccupancyOf(types.get(l.roomTypeId)!), maxOccupancy: types.get(l.roomTypeId)!.maxOccupancy })),
      adults,
      children,
    );
    const terms = (roomTypeId: string) => types.get(roomTypeId)!;
    return {
      party,
      terms,
      price: (i: number, night: Date, planPrice: number | undefined): NightPrice => {
        const line = r.reservationRooms[i];
        return priceRoomNights({ nights: [night], basePrice: planPrice ?? terms(line.roomTypeId).basePrice, ratePlanId: line.ratePlanId, rules: rules.filter((x) => x.roomTypeId === line.roomTypeId), guests: party[i], terms: terms(line.roomTypeId) })[0];
      },
    };
  }

  private async findIdempotent(input: CreateReservationInput): Promise<Reservation | null> {
    if (input.externalReservationId) {
      return findReservation(this.db, { source: input.source, externalReservationId: input.externalReservationId, externalScope: input.externalScope });
    }
    if (input.partnerReference) {
      const byRef = await findReservation(this.db, { propertyId: input.propertyId, partnerReference: input.partnerReference });
      if (byRef) return byRef;
    }
    if (input.idempotencyKey) {
      return findReservation(this.db, { propertyId: input.propertyId, idempotencyKey: input.idempotencyKey });
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
    rules: LoadedRule[],
  ): Omit<ReservationRoom, 'id'>[] {
    // One entry per physical room requested, validated first so a bad request fails before anything is priced.
    const rooms = input.rooms.flatMap((req) => {
      const rt = rtById.get(req.roomTypeId);
      if (!rt) throw new NotFoundError('RoomType', req.roomTypeId);
      if (!ctx.isOta && rt.status !== RoomTypeStatus.ACTIVE) throw new DomainValidationError(`${rt.name} is not bookable`);

      const rp = req.ratePlanId ? rpById.get(req.ratePlanId) : undefined;
      if (req.ratePlanId && !rp) throw new NotFoundError('RatePlan', req.ratePlanId);
      if (rp && rp.roomTypeId !== rt.id) throw new DomainValidationError(`Rate plan ${rp.code} is not for ${rt.name}`);
      if (rp && !ctx.isOta && rp.status !== RatePlanStatus.ACTIVE) throw new DomainValidationError(`Rate plan ${rp.code} is not active`);
      if (!rp && !ctx.isOta) throw new DomainValidationError('ratePlanId is required');
      if (rp && rp.currency !== property.currency) throw new DomainValidationError('Rate plan currency differs from property currency');
      if (req.nightlyRates) {
        if (ctx.isPublicDirect) throw new DomainValidationError('Direct bookings are priced by the server');
        if (req.nightlyRates.length !== nights.length || req.nightlyRates.some((a) => !Number.isInteger(a) || a < 0)) {
          throw new DomainValidationError('nightlyRates must be one non-negative integer per night');
        }
      }
      return Array.from({ length: req.quantity }, () => ({ req, rt, rp }));
    });

    // The party is seated deterministically, so the quote and this booking charge the same extra-guest amounts.
    const party = allocateGuests(
      rooms.map(({ rt }) => ({ baseOccupancy: baseOccupancyOf(rt), maxOccupancy: rt.maxOccupancy })),
      input.adults,
      input.children ?? 0,
    );

    return rooms.map(({ req, rt, rp }, i) => {
      const nightlyRates: NightPrice[] | { date: string; amount: number }[] = req.nightlyRates
        ? // Prices sent by an OTA or entered by staff are taken as given.
          nights.map((date, k) => ({ date: formatDateOnly(date), amount: req.nightlyRates![k] }))
        : priceRoomNights({
            nights,
            basePrice: rp?.basePrice ?? rt.basePrice,
            ratePlanId: rp?.id ?? null,
            rules: rules.filter((r) => r.roomTypeId === rt.id),
            guests: party[i],
            terms: rt,
          });
      const subtotal = sum(nightlyRates.map((n) => n.amount));
      const tax = percentOf(subtotal, property.taxPercent);
      return {
        roomTypeId: rt.id,
        roomTypeName: rt.name,
        roomId: null,
        roomNumber: null,
        quantity: 1,
        ratePlanId: rp?.id ?? null,
        ratePlan: rp ? { code: rp.code, name: rp.name, type: rp.type, mealPlan: rp.mealPlan, cancellationPolicy: rp.cancellationPolicy } : null,
        nightlyRates,
        subtotal,
        tax,
        total: subtotal + tax,
      } satisfies Omit<ReservationRoom, 'id'>;
    });
  }

  private async assertRestrictions(tx: Db, propertyId: Id, roomTypeIds: Id[], checkIn: Date, checkOut: Date) {
    const rows = await tx
      .selectFrom('restrictions')
      .select(['roomTypeId', 'date', 'minimumStay', 'maximumStay', 'closed', 'closedToArrival', 'closedToDeparture', 'stopSell'])
      .where('propertyId', '=', propertyId)
      .where('roomTypeId', 'in', roomTypeIds)
      .where('date', '>=', d(checkIn))
      .where('date', '<=', d(checkOut))
      .execute();
    const violations = roomTypeIds.flatMap((id) =>
      evaluateRestrictions(
        rows.filter((r) => r.roomTypeId === id),
        checkIn,
        checkOut,
      ),
    );
    if (violations.length) throw new RestrictionViolationError(violations);
  }

  private async resolveGuest(tx: Db, propertyId: Id, g: CreateReservationInput['guest']) {
    if ('guestId' in g) {
      const found = await tx.selectFrom('guests').selectAll().where('id', '=', g.guestId).where('propertyId', '=', propertyId).executeTakeFirst();
      if (!found) throw new NotFoundError('Guest', g.guestId);
      return found;
    }
    const email = g.email?.trim().toLowerCase();
    if (email) {
      const found = await tx.selectFrom('guests').selectAll().where('propertyId', '=', propertyId).where('email', '=', email).limit(1).executeTakeFirst();
      if (found) return found;
    }
    return tx
      .insertInto('guests')
      .values({ propertyId, firstName: g.firstName, lastName: g.lastName ?? '', email: email ?? null, phone: g.phone ?? null, country: g.country ?? null, notes: null })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Refund due under the frozen per-line cancellation policies. Inside the free window nothing is forfeited. After it,
   * each line forfeits according to its penaltyType. The guest keeps paid money above the total penalty.
   */
  policyRefund(r: Reservation, property: Pick<Property, 'checkInTime' | 'timezone'>, now: Date): number {
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
  private async createRefunds(tx: Db, r: Pick<Reservation, 'id' | 'propertyId'>, amount: number, reason: string, requestedBy: Id | null): Promise<Refund[]> {
    if (amount <= 0) return [];
    const [payments, pending] = await Promise.all([
      tx
        .selectFrom('payments')
        .selectAll()
        .where('reservationId', '=', r.id)
        .where('status', 'in', [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED])
        .orderBy('createdAt', 'desc')
        .execute(),
      tx.selectFrom('refunds').select(['paymentId', 'amount']).where('reservationId', '=', r.id).where('status', 'in', [RefundStatus.PENDING, RefundStatus.PROCESSING]).execute(),
    ]);
    const pendingByPayment = new Map<string, number>();
    for (const p of pending) pendingByPayment.set(p.paymentId, (pendingByPayment.get(p.paymentId) ?? 0) + p.amount);

    let remaining = amount;
    const docs: { propertyId: string; reservationId: string; paymentId: string; provider: string; amount: number; currency: string; status: string; reason: string; requestedBy: string | null }[] = [];
    for (const p of payments) {
      if (remaining <= 0) break;
      const refundable = p.amount - p.amountRefunded - (pendingByPayment.get(p.id) ?? 0);
      const take = Math.min(refundable, remaining);
      if (take <= 0) continue;
      docs.push({
        propertyId: r.propertyId,
        reservationId: r.id,
        paymentId: p.id,
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
    return tx.insertInto('refunds').values(docs).returningAll().execute();
  }

  private async queueNotifications(tx: Db, property: Property, r: Reservation, overbookedUnits: number) {
    const docs: NewNotification[] = [
      {
        propertyId: r.propertyId,
        reservationId: r.id,
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
        reservationId: r.id,
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
        reservationId: r.id,
        userId: property.ownerId,
        type: NotificationType.OVERBOOKING_ALERT,
        channel: NotificationChannel.IN_APP,
        message: `${r.source} booking ${r.externalReservationId} overbooked ${overbookedUnits} room-night(s). Relocate or upgrade the guest.`,
      });
    }
    await insertNotifications(tx, docs);
    await this.clientEvents.emit(tx, { type: 'reservation.created', property, reservation: r });
    if (r.status === ReservationStatus.CONFIRMED) await this.clientEvents.emit(tx, { type: 'reservation.confirmed', property, reservation: r });
  }
}

// ---------------------------------------------------------------- helpers

/** Rooms needed per room type, from the reservation's lines. */
export function demandOf(lines: Pick<ReservationRoom, 'roomTypeId' | 'quantity'>[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of lines) map.set(l.roomTypeId, (map.get(l.roomTypeId) ?? 0) + l.quantity);
  return map;
}

export function formatMoney(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

function newReservationCode(): string {
  let s = 'TRV-';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

