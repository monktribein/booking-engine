import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { percentOf } from '../common/money';
import { redactSecrets } from '../common/redact';
import type { ChannelRateMapping, ChannelRoomMapping } from '../db-types';
import { ChannelCode, ChannelConnectionStatus, INTERNAL_CHANNELS, MappingStatus, MarkupType, SyncJobType } from '../enums';
import { DomainValidationError, DuplicateError, NotFoundError } from '../errors';
import { Db, InjectDb, isUniqueViolation, j } from '../kysely';

type Id = string;

export interface OutboundTarget {
  mappingId: Id;
  channel: ChannelCode;
  channelListingId: Id;
  externalRoomId: string | null;
  syncAvailability: boolean;
  syncRates: boolean;
  syncRestrictions: boolean;
}

export const SYNC_FLAG_FOR: Record<SyncJobType, keyof OutboundTarget | null> = {
  [SyncJobType.INVENTORY]: 'syncAvailability',
  [SyncJobType.RATES]: 'syncRates',
  [SyncJobType.RESTRICTIONS]: 'syncRestrictions',
  [SyncJobType.RESERVATION]: null,
  [SyncJobType.LISTING]: null,
};

@Injectable()
export class ChannelMappingService {
  constructor(@InjectDb() private readonly db: Db) {}

  // ------------------------------------------------------------ writes

  async upsertListing(input: {
    propertyId: Id;
    channel: ChannelCode;
    externalListingId: string;
    name: string;
    channelConnectionId?: Id | null;
    metadata?: Record<string, unknown>;
  }) {
    if (INTERNAL_CHANNELS.has(input.channel)) {
      throw new DomainValidationError(`${input.channel} reads master inventory directly and has no external listings`);
    }
    // The unique (channel, external_listing_id) key means a listing belongs to exactly one property. The WHERE on the
    // conflict branch refuses to touch a listing that another property already owns (no row comes back).
    const row = await this.db
      .insertInto('channelListings')
      .values({
        propertyId: input.propertyId,
        channel: input.channel,
        externalListingId: input.externalListingId,
        name: input.name,
        channelConnectionId: input.channelConnectionId ?? null,
        metadata: j(redactSecrets(input.metadata ?? {})),
      })
      .onConflict((oc) =>
        oc
          .columns(['channel', 'externalListingId'])
          .doUpdateSet((eb) => ({ name: eb.ref('excluded.name'), metadata: eb.ref('excluded.metadata'), channelConnectionId: eb.ref('excluded.channelConnectionId') }))
          .where('channelListings.propertyId', '=', input.propertyId),
      )
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new DuplicateError('Channel listing (owned by another property)', {});
    return row;
  }

  /** Map a channel listing (optionally one room inside it) to a Tirvona room type. */
  async mapRoom(input: {
    propertyId: Id;
    channelListingId: Id;
    roomTypeId: Id;
    externalRoomId?: string | null;
    syncAvailability?: boolean;
    syncRates?: boolean;
    syncRestrictions?: boolean;
  }) {
    const [listing, roomType] = await Promise.all([
      this.db.selectFrom('channelListings').selectAll().where('id', '=', input.channelListingId).where('propertyId', '=', input.propertyId).executeTakeFirst(),
      this.db.selectFrom('roomTypes').select('id').where('id', '=', input.roomTypeId).where('propertyId', '=', input.propertyId).executeTakeFirst(),
    ]);
    if (!listing) throw new NotFoundError('ChannelListing', input.channelListingId);
    if (!roomType) throw new NotFoundError('RoomType', input.roomTypeId);
    try {
      return await this.db
        .insertInto('channelRoomMappings')
        .values({
          propertyId: input.propertyId,
          channel: listing.channel,
          channelListingId: listing.id,
          externalRoomId: input.externalRoomId ?? null,
          roomTypeId: roomType.id,
          syncAvailability: input.syncAvailability ?? true,
          syncRates: input.syncRates ?? true,
          syncRestrictions: input.syncRestrictions ?? true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateError('Channel room mapping', {});
      throw err;
    }
  }

  async mapRatePlan(input: {
    propertyId: Id;
    channelRoomMappingId: Id;
    externalRatePlanId: string;
    ratePlanId: Id;
    markupType?: MarkupType;
    markupValue?: number;
  }) {
    const [mapping, ratePlan] = await Promise.all([
      this.db.selectFrom('channelRoomMappings').selectAll().where('id', '=', input.channelRoomMappingId).where('propertyId', '=', input.propertyId).executeTakeFirst(),
      this.db.selectFrom('ratePlans').select(['id', 'roomTypeId']).where('id', '=', input.ratePlanId).where('propertyId', '=', input.propertyId).executeTakeFirst(),
    ]);
    if (!mapping) throw new NotFoundError('ChannelRoomMapping', input.channelRoomMappingId);
    if (!ratePlan) throw new NotFoundError('RatePlan', input.ratePlanId);
    if (ratePlan.roomTypeId !== mapping.roomTypeId) {
      throw new DomainValidationError('Rate plan belongs to a different room type than the room mapping');
    }
    const markupType = input.markupType ?? MarkupType.NONE;
    const markupValue = input.markupValue ?? 0;
    if (markupType === MarkupType.NONE && markupValue !== 0) throw new DomainValidationError('markupValue must be 0 when markupType is NONE');
    if (markupType === MarkupType.PERCENTAGE && (markupValue < -90 || markupValue > 500)) throw new DomainValidationError('Percentage markup must be between -90 and 500');
    if (markupType === MarkupType.FIXED && !Number.isInteger(markupValue)) throw new DomainValidationError('Fixed markup must be an integer in minor units');
    try {
      return await this.db
        .insertInto('channelRateMappings')
        .values({
          propertyId: input.propertyId,
          channel: mapping.channel,
          channelRoomMappingId: mapping.id,
          externalRatePlanId: input.externalRatePlanId,
          ratePlanId: ratePlan.id,
          markupType,
          markupValue,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateError('Channel rate mapping', {});
      throw err;
    }
  }

  // ------------------------------------------------------------ inbound (channel → Tirvona)

  /** Resolve an inbound booking's listing/room to our property and room type. */
  async resolveInboundRoom(channel: ChannelCode, externalListingId: string, externalRoomId: string | null = null) {
    const listing = await this.db.selectFrom('channelListings').selectAll().where('channel', '=', channel).where('externalListingId', '=', externalListingId).executeTakeFirst();
    if (!listing) return null;
    let q = this.db.selectFrom('channelRoomMappings').selectAll().where('channelListingId', '=', listing.id).where('status', '<>', MappingStatus.ARCHIVED);
    q = externalRoomId === null ? q.where('externalRoomId', 'is', null) : q.where('externalRoomId', '=', externalRoomId);
    const mapping = (await q.executeTakeFirst()) ?? null;
    return { listing, mapping, propertyId: listing.propertyId, roomTypeId: mapping?.roomTypeId ?? null };
  }

  async resolveInboundRatePlan(channelRoomMappingId: Id, externalRatePlanId: string): Promise<ChannelRateMapping | null> {
    return (
      (await this.db
        .selectFrom('channelRateMappings')
        .selectAll()
        .where('channelRoomMappingId', '=', channelRoomMappingId)
        .where('externalRatePlanId', '=', externalRatePlanId)
        .where('status', '<>', MappingStatus.ARCHIVED)
        .executeTakeFirst()) ?? null
    );
  }

  // ------------------------------------------------------------ outbound (Tirvona → channel)

  /**
   * Channel listings that consume a room type and should receive updates. Only ACTIVE mappings on CONNECTED external
   * channels qualify. After a reconnect, a full resync job is queued (see SyncJobService.enqueueFullResync).
   */
  async getOutboundTargets(propertyId: Id, roomTypeId: Id, q: Db = this.db): Promise<OutboundTarget[]> {
    const rows = await q
      .selectFrom('channelRoomMappings as m')
      .innerJoin('channelConnections as c', (join) => join.onRef('c.propertyId', '=', 'm.propertyId').onRef('c.channel', '=', 'm.channel'))
      .select(['m.id as mappingId', 'm.channel', 'm.channelListingId', 'm.externalRoomId', 'm.syncAvailability', 'm.syncRates', 'm.syncRestrictions'])
      .where('m.propertyId', '=', propertyId)
      .where('m.roomTypeId', '=', roomTypeId)
      .where('m.status', '=', MappingStatus.ACTIVE)
      .where('c.status', '=', ChannelConnectionStatus.CONNECTED)
      .execute();
    return rows.filter((r) => !INTERNAL_CHANNELS.has(r.channel as ChannelCode)).map((r) => ({ ...r, channel: r.channel as ChannelCode }));
  }

  /** Price to push to a channel for a mapped rate plan. */
  static channelPrice(basePrice: number, mapping: Pick<ChannelRateMapping, 'markupType' | 'markupValue'>): number {
    switch (mapping.markupType) {
      case MarkupType.PERCENTAGE:
        return Math.max(0, basePrice + percentOf(basePrice, mapping.markupValue));
      case MarkupType.FIXED:
        return Math.max(0, basePrice + mapping.markupValue);
      default:
        return basePrice;
    }
  }

  // ------------------------------------------------------------ read models

  /** Every listing of a property with its room mappings, room type names and rate mappings. */
  async listListingsWithMappings(propertyId: Id) {
    const res = await sql<Record<string, unknown>>`
      select l.id, l.channel, l.external_listing_id, l.name, l.status, l.last_synced_at,
        coalesce((
          select json_agg(json_build_object(
            'id', m.id, 'externalRoomId', m.external_room_id, 'status', m.status,
            'syncAvailability', m.sync_availability, 'syncRates', m.sync_rates, 'syncRestrictions', m.sync_restrictions,
            'roomTypeId', m.room_type_id, 'roomTypeName', rt.name,
            'rateMappings', coalesce((
              select json_agg(json_build_object('externalRatePlanId', rm.external_rate_plan_id, 'ratePlanId', rm.rate_plan_id,
                                                'markupType', rm.markup_type, 'markupValue', rm.markup_value, 'status', rm.status))
              from channel_rate_mappings rm where rm.channel_room_mapping_id = m.id), '[]'::json)
          ) order by rt.name)
          from channel_room_mappings m join room_types rt on rt.id = m.room_type_id
          where m.channel_listing_id = l.id), '[]'::json) as room_mappings
      from channel_listings l
      where l.property_id = ${propertyId}::uuid
      order by l.channel, l.name`.execute(this.db);
    return res.rows;
  }

  /** Listings that exist on a channel but are not yet connected to any room type. They sell nothing. */
  async findUnmappedListings(propertyId: Id) {
    return this.db
      .selectFrom('channelListings as l')
      .select(['l.id', 'l.propertyId', 'l.channelConnectionId', 'l.channel', 'l.externalListingId', 'l.name', 'l.status', 'l.lastSyncedAt', 'l.createdAt', 'l.updatedAt'])
      .where('l.propertyId', '=', propertyId)
      .where('l.status', '=', 'ACTIVE')
      .where((eb) => eb.not(eb.exists(eb.selectFrom('channelRoomMappings as m').select('m.id').whereRef('m.channelListingId', '=', 'l.id').where('m.status', '<>', MappingStatus.ARCHIVED))))
      .execute();
  }

  /** Room types not distributed on any external channel. */
  async findUndistributedRoomTypes(propertyId: Id) {
    return this.db
      .selectFrom('roomTypes as rt')
      .select(['rt.id', 'rt.name', 'rt.slug'])
      .where('rt.propertyId', '=', propertyId)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('channelRoomMappings as m').select('m.id').whereRef('m.roomTypeId', '=', 'rt.id').where('m.propertyId', '=', propertyId).where('m.status', '=', MappingStatus.ACTIVE))))
      .execute();
  }

  async mappingsForRoomType(propertyId: Id, roomTypeId: Id): Promise<ChannelRoomMapping[]> {
    return this.db.selectFrom('channelRoomMappings').selectAll().where('propertyId', '=', propertyId).where('roomTypeId', '=', roomTypeId).execute();
  }
}
