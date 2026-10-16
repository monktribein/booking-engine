import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { WebhookEvent } from '../db-types';
import { ChannelCode, GLOBAL_EXTERNAL_SCOPE, ReservationSource, WebhookEventStatus, WebhookSource, channelToSource } from '../enums';
import { DomainError } from '../errors';
import { Db, InjectDb, isUniqueViolation, j } from '../kysely';
import { ChannelMappingService } from './channel-mapping.service';
import { ReservationService } from './reservation.service';

type Id = string;

const LEASE_MS = 120_000;
export const WEBHOOK_MAX_ATTEMPTS = 10;

/**
 * Channel-neutral shape that every channel adapter turns its own payload into. The core never parses OTA wire formats.
 * Adapters are written against each channel's official, documented partner API.
 */
export interface NormalizedReservationEvent {
  kind: 'RESERVATION_CREATED' | 'RESERVATION_MODIFIED' | 'RESERVATION_CANCELLED';
  channel: string;
  externalListingId: string;
  externalReservationId: string;
  /** Connection scope for configured providers (their ids are unique per connection, not globally). Absent = global scope. */
  externalScope?: string;
  /** The provider's own version marker of this state of the booking (its updated-at), when it has one: part of the poll event id. */
  revision?: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  guest: { firstName: string; lastName: string; email?: string; phone?: string };
  rooms: { externalRoomId?: string | null; externalRatePlanId?: string; quantity: number; nightlyRates: number[] }[];
  currency: string;
  paymentCollectedByChannel: boolean;
  specialRequests?: string;
}

export interface ReservationEventOutcome {
  action: 'CREATED' | 'DUPLICATE' | 'MODIFIED' | 'CANCELLED' | 'ALREADY_CANCELLED';
  reservationId: Id;
  propertyId: Id;
}

@Injectable()
export class WebhookService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly channels: ChannelMappingService,
    private readonly reservations: ReservationService,
  ) {}

  /**
   * Step 1, in the HTTP handler: persist first, then return quickly. The unique (channel, external_event_id) key turns
   * redeliveries into `duplicate: true` without any read-before-write race.
   */
  async ingest(input: {
    channel: WebhookSource;
    /** Connection scope of the event id (configured providers). Absent = global scope. */
    externalScope?: string;
    eventType: string;
    externalEventId?: string;
    payload: Record<string, unknown>;
    rawBody?: string | Buffer;
    signature?: string;
    signatureValid: boolean;
    propertyId?: Id | null;
  }): Promise<{ event: WebhookEvent; duplicate: boolean }> {
    const bodyHash = createHash('sha256').update(input.rawBody ?? JSON.stringify(input.payload)).digest('hex');
    // Unauthenticated events never occupy a real event id; otherwise a forger could pre-register the id of a legitimate
    // future event and get the genuine delivery dropped as a duplicate.
    const externalEventId = input.signatureValid ? input.externalEventId ?? bodyHash : `invalid:${bodyHash}`;
    try {
      const event = await this.db
        .insertInto('webhookEvents')
        .values({
          channel: input.channel,
          ...(input.externalScope ? { externalScope: input.externalScope } : {}),
          propertyId: input.propertyId ?? null,
          eventType: input.eventType,
          externalEventId,
          payload: j(input.payload),
          signature: input.signature?.slice(0, 1000) ?? null,
          signatureValid: input.signatureValid,
          // Unsigned or forged events are kept for forensics but never processed.
          status: input.signatureValid ? WebhookEventStatus.RECEIVED : WebhookEventStatus.IGNORED,
          error: input.signatureValid ? null : 'Invalid signature',
          lockedUntil: null,
          enqueuedAt: null,
          processedAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { event, duplicate: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const event = await this.db.selectFrom('webhookEvents').selectAll().where('channel', '=', input.channel).where('externalScope', '=', input.externalScope ?? GLOBAL_EXTERNAL_SCOPE).where('externalEventId', '=', externalEventId).executeTakeFirstOrThrow();
      return { event, duplicate: true };
    }
  }

  async markEnqueued(eventId: Id): Promise<void> {
    await this.db.updateTable('webhookEvents').set({ enqueuedAt: new Date() }).where('id', '=', eventId).execute();
  }

  /** Step 2, in a worker: lease one event. Null if it was processed already or another worker holds it. */
  async claimById(eventId: Id, now = new Date()): Promise<WebhookEvent | null> {
    const row = await this.db
      .updateTable('webhookEvents')
      .set({ status: WebhookEventStatus.PROCESSING, lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`attempts + 1` })
      .where('id', '=', eventId)
      .where((w) =>
        w.or([w('status', 'in', [WebhookEventStatus.RECEIVED, WebhookEventStatus.FAILED]), w.and([w('status', '=', WebhookEventStatus.PROCESSING), w('lockedUntil', '<', now)])]),
      )
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  }

  /** Poll-based alternative to claimById, for workers without a queue. */
  async claimNext(now = new Date()): Promise<WebhookEvent | null> {
    const row = await this.db
      .updateTable('webhookEvents')
      .set({ status: WebhookEventStatus.PROCESSING, lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`attempts + 1` })
      .where('id', '=', (eb) =>
        eb
          .selectFrom('webhookEvents')
          .select('id')
          .where((w) => w.or([w('status', '=', WebhookEventStatus.RECEIVED), w.and([w('status', '=', WebhookEventStatus.PROCESSING), w('lockedUntil', '<', now)])]))
          .where('attempts', '<', WEBHOOK_MAX_ATTEMPTS)
          .orderBy('createdAt')
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Step 3: apply a normalised reservation event. Idempotent twice over: the event row is unique, and the reservation's
   * (source, external_reservation_id) is unique too, so replaying an event can never create a second booking. Status
   * bookkeeping (processed/failed) is left to the caller.
   */
  async applyReservationEvent(e: NormalizedReservationEvent): Promise<ReservationEventOutcome> {
    const source: string = channelToSource(e.channel);
    const scope = e.externalScope ?? GLOBAL_EXTERNAL_SCOPE;

    if (e.kind === 'RESERVATION_CANCELLED') {
      const r = await this.reservations.cancelByExternalId(source, e.externalReservationId, `Cancelled on ${e.channel}`, scope);
      return { action: r.alreadyCancelled ? 'ALREADY_CANCELLED' : 'CANCELLED', reservationId: r.reservation.id, propertyId: r.reservation.propertyId };
    }

    if (e.kind === 'RESERVATION_MODIFIED') {
      const existing = await this.db.selectFrom('reservations').select('id').where('source', '=', source).where('externalScope', '=', scope).where('externalReservationId', '=', e.externalReservationId).executeTakeFirst();
      // A modification for a booking we never saw is treated as a creation.
      if (existing) {
        const r = await this.reservations.modifyByExternalId(source, e.externalReservationId, {
          checkIn: e.checkIn,
          checkOut: e.checkOut,
          adults: e.adults,
          children: e.children,
          nightlyRatesByLine: expandRates(e.rooms),
          specialRequests: e.specialRequests,
        }, scope);
        return { action: 'MODIFIED', reservationId: r.id, propertyId: r.propertyId };
      }
    }

    const rooms = [];
    let propertyId: Id | null = null;
    let channelListingId: Id | null = null;
    for (const room of e.rooms) {
      const resolved = await this.channels.resolveInboundRoom(e.channel, e.externalListingId, room.externalRoomId ?? null, scope);
      if (!resolved?.mapping || !resolved.roomTypeId) {
        throw new DomainError('CHANNEL_MAPPING_MISSING', `No room mapping for ${e.channel} listing ${e.externalListingId} room ${room.externalRoomId ?? '-'}`);
      }
      propertyId = resolved.propertyId;
      channelListingId = resolved.listing.id;
      const rate = room.externalRatePlanId ? await this.channels.resolveInboundRatePlan(resolved.mapping.id, room.externalRatePlanId) : null;
      rooms.push({ roomTypeId: resolved.roomTypeId, ratePlanId: rate?.ratePlanId ?? null, quantity: room.quantity, nightlyRates: room.nightlyRates });
    }
    if (!propertyId) throw new DomainError('CHANNEL_MAPPING_MISSING', 'Event contains no rooms');

    const res = await this.reservations.createReservation({
      propertyId,
      source,
      externalReservationId: e.externalReservationId,
      externalScope: e.externalScope,
      channelListingId,
      guest: e.guest,
      checkIn: e.checkIn,
      checkOut: e.checkOut,
      adults: e.adults,
      children: e.children,
      rooms,
      specialRequests: e.specialRequests,
      paymentCollectedByChannel: e.paymentCollectedByChannel,
    });
    return { action: res.created ? 'CREATED' : 'DUPLICATE', reservationId: res.reservation.id, propertyId };
  }

  async markProcessed(eventId: Id, propertyId: Id | null = null): Promise<void> {
    await this.db.updateTable('webhookEvents').set({ status: WebhookEventStatus.PROCESSED, processedAt: new Date(), lockedUntil: null, propertyId, error: null }).where('id', '=', eventId).execute();
  }

  async markIgnored(eventId: Id, reason: string): Promise<void> {
    await this.db.updateTable('webhookEvents').set({ status: WebhookEventStatus.IGNORED, processedAt: new Date(), lockedUntil: null, error: reason.slice(0, 4000) }).where('id', '=', eventId).execute();
  }

  /** `final` = no retries left: FAILED for a human. Otherwise back to RECEIVED for the next attempt. */
  async markFailed(eventId: Id, error: string, final = false): Promise<void> {
    await this.db
      .updateTable('webhookEvents')
      .set({ status: final ? WebhookEventStatus.FAILED : WebhookEventStatus.RECEIVED, lockedUntil: null, error: error.slice(0, 4000) })
      .where('id', '=', eventId)
      .execute();
  }
}

/** Line-by-line nightly rates in the order the reservation expands them (one line per unit). */
function expandRates(rooms: NormalizedReservationEvent['rooms']): number[][] {
  return rooms.flatMap((r) => Array.from({ length: r.quantity }, () => r.nightlyRates));
}
