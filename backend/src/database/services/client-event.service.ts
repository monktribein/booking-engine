import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { Connection, Types } from 'mongoose';
import { apiReservationView } from '../common/api-views';
import { ApiEventType, WebhookDeliveryStatus, WebhookEndpointStatus } from '../enums';
import { Models, getModels } from '../models';
import type { Property } from '../schemas/property.schema';
import type { Reservation } from '../schemas/reservation.schema';

export const API_VERSION = 'v1';

export interface ClientEventInput {
  type: ApiEventType;
  property: Pick<Property, '_id' | 'organizationId' | 'slug' | 'name'>;
  reservation: Reservation;
  /** Makes the event id unique where one reservation can emit the same type more than once (e.g. two payments). */
  discriminator?: string;
  /** Extra, non-sensitive fields merged into `data` (e.g. the payment summary). */
  extra?: Record<string, unknown>;
}

/**
 * Fans a domain event out to the organization's webhook endpoints by inserting
 * webhook_deliveries rows. Call it with the business transaction's session so
 * an event exists if and only if the change committed. The deterministic event
 * id plus the unique (endpointId, eventId) index make a repeated call a no-op,
 * so retries of the surrounding transaction never double-deliver.
 */
@Injectable()
export class ClientEventService {
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

  static eventId(type: string, entityId: Types.ObjectId | string, discriminator = ''): string {
    return `evt_${createHash('sha256').update(`${type}|${String(entityId)}|${discriminator}`).digest('hex').slice(0, 32)}`;
  }

  /** Body exactly as it is POSTed. Stored verbatim so retries are byte-identical. */
  static buildBody(id: string, type: ApiEventType, data: Record<string, unknown>, createdAt = new Date()): string {
    return JSON.stringify({ id, type, apiVersion: API_VERSION, createdAt: createdAt.toISOString(), data });
  }

  async emit(session: ClientSession | null, input: ClientEventInput): Promise<number> {
    const { property, reservation } = input;
    const endpoints = await this.m.WebhookEndpoint.find(
      {
        organizationId: property.organizationId,
        status: WebhookEndpointStatus.ACTIVE,
        $and: [{ $or: [{ propertyIds: { $size: 0 } }, { propertyIds: property._id }] }, { $or: [{ events: '*' }, { events: input.type }] }],
      },
      { _id: 1 },
    )
      .session(session)
      .lean();
    if (!endpoints.length) return 0;

    const eventId = ClientEventService.eventId(input.type, reservation._id, input.discriminator);
    const body = ClientEventService.buildBody(eventId, input.type, { reservation: apiReservationView(reservation, property), ...(input.extra ?? {}) });
    await this.m.WebhookDelivery.bulkWrite(
      endpoints.map((e) => ({
        updateOne: {
          filter: { endpointId: e._id, eventId },
          update: { $setOnInsert: { organizationId: property.organizationId, endpointId: e._id, eventId, eventType: input.type, body, status: WebhookDeliveryStatus.PENDING, attempts: 0, maxAttempts: 12, lockedUntil: null, enqueuedAt: null } },
          upsert: true,
        },
      })),
      { session: session ?? undefined, ordered: false },
    );
    return endpoints.length;
  }
}
