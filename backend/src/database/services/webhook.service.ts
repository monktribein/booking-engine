import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Connection, Types } from 'mongoose';
import { isDuplicateKeyError } from '../common/schema-helpers';
import { ChannelCode, ReservationSource, WebhookEventStatus, WebhookSource, channelToSource } from '../enums';
import { DomainError } from '../errors';
import { Models, getModels } from '../models';
import type { WebhookEvent } from '../schemas/ops.schema';
import { ChannelMappingService } from './channel-mapping.service';
import { ReservationService } from './reservation.service';

type Id = Types.ObjectId;

const LEASE_MS = 120_000;
export const WEBHOOK_MAX_ATTEMPTS = 10;

/**
 * Channel-neutral shape that every channel adapter turns its own payload into.
 * The core never parses OTA wire formats. Adapters are written against each
 * channel's official, documented partner API.
 */
export interface NormalizedReservationEvent {
  kind: 'RESERVATION_CREATED' | 'RESERVATION_MODIFIED' | 'RESERVATION_CANCELLED';
  channel: ChannelCode;
  externalListingId: string;
  externalReservationId: string;
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
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly channels: ChannelMappingService,
    private readonly reservations: ReservationService,
  ) {
    this.m = getModels(connection);
  }

  /**
   * Step 1, in the HTTP handler: persist first, then return quickly.
   * The unique {channel, externalEventId} index turns redeliveries into
   * `duplicate: true` without any read-before-write race.
   */
  async ingest(input: {
    channel: WebhookSource;
    eventType: string;
    externalEventId?: string;
    payload: Record<string, unknown>;
    rawBody?: string | Buffer;
    signature?: string;
    signatureValid: boolean;
    propertyId?: Id | null;
  }): Promise<{ event: WebhookEvent; duplicate: boolean }> {
    const bodyHash = createHash('sha256').update(input.rawBody ?? JSON.stringify(input.payload)).digest('hex');
    // Unauthenticated events never occupy a real event id; otherwise a forger could pre-register the id
    // of a legitimate future event and get the genuine delivery dropped as a duplicate.
    const externalEventId = input.signatureValid ? input.externalEventId ?? bodyHash : `invalid:${bodyHash}`;
    try {
      const [event] = await this.m.WebhookEvent.create([
        {
          channel: input.channel,
          propertyId: input.propertyId ?? null,
          eventType: input.eventType,
          externalEventId,
          payload: input.payload,
          signature: input.signature?.slice(0, 1000),
          signatureValid: input.signatureValid,
          // Unsigned or forged events are kept for forensics but never processed.
          status: input.signatureValid ? WebhookEventStatus.RECEIVED : WebhookEventStatus.IGNORED,
          error: input.signatureValid ? undefined : 'Invalid signature',
        },
      ]);
      return { event: event.toObject(), duplicate: false };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const event = await this.m.WebhookEvent.findOne({ channel: input.channel, externalEventId }).lean();
      return { event: event!, duplicate: true };
    }
  }

  async markEnqueued(eventId: Id): Promise<void> {
    await this.m.WebhookEvent.updateOne({ _id: eventId }, { $set: { enqueuedAt: new Date() } });
  }

  /** Step 2, in a worker: lease one event. Null if it was processed already or another worker holds it. */
  async claimById(eventId: Id, now = new Date()): Promise<WebhookEvent | null> {
    return this.m.WebhookEvent.findOneAndUpdate(
      {
        _id: eventId,
        $or: [
          { status: { $in: [WebhookEventStatus.RECEIVED, WebhookEventStatus.FAILED] } },
          { status: WebhookEventStatus.PROCESSING, lockedUntil: { $lt: now } },
        ],
      },
      { $set: { status: WebhookEventStatus.PROCESSING, lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { new: true },
    ).lean();
  }

  /** Poll-based alternative to claimById, for workers without a queue. */
  async claimNext(now = new Date()): Promise<WebhookEvent | null> {
    return this.m.WebhookEvent.findOneAndUpdate(
      {
        $or: [
          { status: WebhookEventStatus.RECEIVED },
          { status: WebhookEventStatus.PROCESSING, lockedUntil: { $lt: now } },
        ],
        attempts: { $lt: WEBHOOK_MAX_ATTEMPTS },
      },
      { $set: { status: WebhookEventStatus.PROCESSING, lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true },
    ).lean();
  }

  /**
   * Step 3: apply a normalised reservation event. Idempotent twice over: the
   * event row is unique, and the reservation's (source, externalReservationId)
   * is unique too, so replaying an event can never create a second booking.
   * Status bookkeeping (processed/failed) is left to the caller.
   */
  async applyReservationEvent(e: NormalizedReservationEvent): Promise<ReservationEventOutcome> {
    const source: ReservationSource = channelToSource(e.channel);

    if (e.kind === 'RESERVATION_CANCELLED') {
      const r = await this.reservations.cancelByExternalId(source, e.externalReservationId, `Cancelled on ${e.channel}`);
      return {
        action: r.alreadyCancelled ? 'ALREADY_CANCELLED' : 'CANCELLED',
        reservationId: r.reservation._id,
        propertyId: r.reservation.propertyId,
      };
    }

    if (e.kind === 'RESERVATION_MODIFIED') {
      const existing = await this.m.Reservation.findOne(
        { source, externalReservationId: e.externalReservationId },
        { _id: 1 },
      ).lean();
      // A modification for a booking we never saw is treated as a creation.
      if (existing) {
        const r = await this.reservations.modifyByExternalId(source, e.externalReservationId, {
          checkIn: e.checkIn,
          checkOut: e.checkOut,
          adults: e.adults,
          children: e.children,
          nightlyRatesByLine: expandRates(e.rooms),
          specialRequests: e.specialRequests,
        });
        return { action: 'MODIFIED', reservationId: r._id, propertyId: r.propertyId };
      }
    }

    const rooms = [];
    let propertyId: Id | null = null;
    let channelListingId: Id | null = null;
    for (const room of e.rooms) {
      const resolved = await this.channels.resolveInboundRoom(e.channel, e.externalListingId, room.externalRoomId ?? null);
      if (!resolved?.mapping || !resolved.roomTypeId) {
        throw new DomainError(
          'CHANNEL_MAPPING_MISSING',
          `No room mapping for ${e.channel} listing ${e.externalListingId} room ${room.externalRoomId ?? '-'}`,
        );
      }
      propertyId = resolved.propertyId;
      channelListingId = resolved.listing._id;
      const rate = room.externalRatePlanId
        ? await this.channels.resolveInboundRatePlan(resolved.mapping._id, room.externalRatePlanId)
        : null;
      rooms.push({
        roomTypeId: resolved.roomTypeId,
        ratePlanId: rate?.ratePlanId ?? null,
        quantity: room.quantity,
        nightlyRates: room.nightlyRates,
      });
    }
    if (!propertyId) throw new DomainError('CHANNEL_MAPPING_MISSING', 'Event contains no rooms');

    const res = await this.reservations.createReservation({
      propertyId,
      source,
      externalReservationId: e.externalReservationId,
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
    return { action: res.created ? 'CREATED' : 'DUPLICATE', reservationId: res.reservation._id, propertyId };
  }

  async markProcessed(eventId: Id, propertyId: Id | null = null): Promise<void> {
    await this.m.WebhookEvent.updateOne(
      { _id: eventId },
      { $set: { status: WebhookEventStatus.PROCESSED, processedAt: new Date(), lockedUntil: null, propertyId, error: null } },
    );
  }

  async markIgnored(eventId: Id, reason: string): Promise<void> {
    await this.m.WebhookEvent.updateOne(
      { _id: eventId },
      { $set: { status: WebhookEventStatus.IGNORED, processedAt: new Date(), lockedUntil: null, error: reason.slice(0, 4000) } },
    );
  }

  /** `final` = no retries left: FAILED for a human. Otherwise back to RECEIVED for the next attempt. */
  async markFailed(eventId: Id, error: string, final = false): Promise<void> {
    await this.m.WebhookEvent.updateOne(
      { _id: eventId },
      {
        $set: {
          status: final ? WebhookEventStatus.FAILED : WebhookEventStatus.RECEIVED,
          lockedUntil: null,
          error: error.slice(0, 4000),
        },
      },
    );
  }
}

/** Line-by-line nightly rates in the order the reservation expands them (one line per unit). */
function expandRates(rooms: NormalizedReservationEvent['rooms']): number[][] {
  return rooms.flatMap((r) => Array.from({ length: r.quantity }, () => r.nightlyRates));
}
