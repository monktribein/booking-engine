import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { apiReservationView, paymentSummary, redactGuest } from '../common/api-views';
import type { Property } from '../db-types';
import { ApiEventType, WebhookEndpointStatus } from '../enums';
import { Db, InjectDb } from '../kysely';
import type { Reservation } from '../reservation-store';

export const API_VERSION = 'v1';

export interface ClientEventInput {
  type: ApiEventType;
  property: Pick<Property, 'id' | 'organizationId' | 'slug' | 'name'>;
  reservation: Reservation;
  /** Makes the event id unique where one reservation can emit the same type more than once (e.g. two payments). */
  discriminator?: string;
  /** Extra, non-sensitive fields merged into `data` (e.g. the payment summary). */
  extra?: Record<string, unknown>;
}

/**
 * Fans a domain event out to the organization's webhook endpoints by inserting webhook_deliveries rows. Call it with
 * the business transaction so an event exists if and only if the change committed. The deterministic event id plus the
 * unique (endpoint_id, event_id) constraint make a repeated call a no-op (ON CONFLICT DO NOTHING), so retries of the
 * surrounding transaction never double-deliver.
 */
@Injectable()
export class ClientEventService {
  constructor(@InjectDb() private readonly db: Db) {}

  static eventId(type: string, entityId: string, discriminator = ''): string {
    return `evt_${createHash('sha256').update(`${type}|${entityId}|${discriminator}`).digest('hex').slice(0, 32)}`;
  }

  /** Body exactly as it is POSTed. Stored verbatim so retries are byte-identical. */
  static buildBody(id: string, type: ApiEventType, data: Record<string, unknown>, createdAt = new Date()): string {
    return JSON.stringify({ id, type, apiVersion: API_VERSION, createdAt: createdAt.toISOString(), data });
  }

  /** Inserts one delivery per subscribed endpoint of the property's organization. Idempotent on (endpoint, event id). */
  private async fanOut(conn: Db, property: Pick<Property, 'id' | 'organizationId'>, type: ApiEventType, eventId: string, data: Record<string, unknown>, redacted: Record<string, unknown> = data): Promise<number> {
    // Subscribed to every property (empty list) or to this one; subscribed to every event ('*') or to this type.
    const endpoints = await conn
      .selectFrom('webhookEndpoints')
      .select(['id', 'includeGuestDetails'])
      .where('organizationId', '=', property.organizationId)
      .where('status', '=', WebhookEndpointStatus.ACTIVE)
      .where(sql<boolean>`(cardinality(property_ids) = 0 or property_ids @> array[${property.id}]::uuid[])`)
      .where(sql<boolean>`(events @> array['*']::text[] or events @> array[${type}]::text[])`)
      .execute();
    if (!endpoints.length) return 0;

    // Two renderings of one event: with and without guest contact details. Each endpoint gets the one its owner chose, and the
    // body is stored verbatim, so every retry is byte-identical.
    const now = new Date();
    const full = ClientEventService.buildBody(eventId, type, data, now);
    const lean = data === redacted ? full : ClientEventService.buildBody(eventId, type, redacted, now);
    await conn
      .insertInto('webhookDeliveries')
      .values(
        endpoints.map((e) => ({
          organizationId: property.organizationId,
          endpointId: e.id,
          eventId,
          eventType: type,
          body: e.includeGuestDetails ? full : lean,
          maxAttempts: 12,
          lockedUntil: null,
          enqueuedAt: null,
          lastStatusCode: null,
          lastError: null,
          deliveredAt: null,
        })),
      )
      .onConflict((oc) => oc.columns(['endpointId', 'eventId']).doNothing())
      .execute();
    return endpoints.length;
  }

  /** A reservation event (created, confirmed, updated, cancelled, payment.*). */
  async emit(q: Db | null, input: ClientEventInput): Promise<number> {
    const conn = q ?? this.db;
    const { property, reservation } = input;
    const eventId = ClientEventService.eventId(input.type, reservation.id, input.discriminator);
    const view = apiReservationView(reservation, property);
    const extra = { ...(input.extra ?? {}) };
    // A full payment row (payment.succeeded) is reduced to a summary: no gateway metadata such as UPI ids or card details.
    if (extra.payment && typeof extra.payment === 'object' && 'provider' in extra.payment) extra.payment = paymentSummary(extra.payment as Parameters<typeof paymentSummary>[0]);
    return this.fanOut(conn, property, input.type, eventId, { reservation: view, ...extra }, { reservation: redactGuest(view), ...extra });
  }

  /**
   * `inventory.updated`: sellable inventory of a room type changed through an explicit availability action (restrictions,
   * stop-sell, blocks, room count). The payload names WHAT changed, never guest data; the receiver re-reads the inventory
   * (`GET /v1/properties/{slug}/inventory`). Booking-driven changes are conveyed by the reservation events instead.
   */
  async emitInventory(
    q: Db | null,
    input: { propertyId: string; roomTypeId: string; from: string | null; to: string | null; reason: 'restrictions' | 'block' | 'block_released' | 'capacity' },
  ): Promise<number> {
    const conn = q ?? this.db;
    const property = await conn.selectFrom('properties').select(['id', 'organizationId', 'slug']).where('id', '=', input.propertyId).executeTakeFirst();
    if (!property) return 0;
    const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 32)}`;
    return this.fanOut(conn, property, 'inventory.updated', eventId, { propertyId: property.id, propertySlug: property.slug, roomTypeId: input.roomTypeId, from: input.from, to: input.to, reason: input.reason });
  }
}
