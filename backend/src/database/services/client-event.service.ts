import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { apiReservationView } from '../common/api-views';
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

  async emit(q: Db | null, input: ClientEventInput): Promise<number> {
    const conn = q ?? this.db;
    const { property, reservation } = input;
    // Subscribed to every property (empty list) or to this one; subscribed to every event ('*') or to this type.
    const endpoints = await conn
      .selectFrom('webhookEndpoints')
      .select('id')
      .where('organizationId', '=', property.organizationId)
      .where('status', '=', WebhookEndpointStatus.ACTIVE)
      .where(sql<boolean>`(cardinality(property_ids) = 0 or property_ids @> array[${property.id}]::uuid[])`)
      .where(sql<boolean>`(events @> array['*']::text[] or events @> array[${input.type}]::text[])`)
      .execute();
    if (!endpoints.length) return 0;

    const eventId = ClientEventService.eventId(input.type, reservation.id, input.discriminator);
    const body = ClientEventService.buildBody(eventId, input.type, { reservation: apiReservationView(reservation, property), ...(input.extra ?? {}) });
    await conn
      .insertInto('webhookDeliveries')
      .values(
        endpoints.map((e) => ({
          organizationId: property.organizationId,
          endpointId: e.id,
          eventId,
          eventType: input.type,
          body,
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
}
