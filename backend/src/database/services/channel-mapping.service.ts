import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession } from 'mongodb';
import { Connection, Types } from 'mongoose';
import { COLLECTION } from '../constants';
import { percentOf } from '../common/money';
import { isDuplicateKeyError } from '../common/schema-helpers';
import {
  ChannelCode,
  ChannelConnectionStatus,
  ChannelListingStatus,
  INTERNAL_CHANNELS,
  MappingStatus,
  MarkupType,
  SyncJobType,
} from '../enums';
import { DomainValidationError, DuplicateError, NotFoundError } from '../errors';
import { Models, getModels } from '../models';
import type { ChannelRateMapping, ChannelRoomMapping } from '../schemas/channel.schema';

type Id = Types.ObjectId;

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
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

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
    try {
      return await this.m.ChannelListing.findOneAndUpdate(
        { channel: input.channel, externalListingId: input.externalListingId, propertyId: input.propertyId },
        {
          $set: { name: input.name, metadata: input.metadata ?? {}, channelConnectionId: input.channelConnectionId ?? null },
          $setOnInsert: { status: ChannelListingStatus.ACTIVE },
        },
        { upsert: true, new: true, runValidators: true },
      ).lean();
    } catch (err) {
      // The unique {channel, externalListingId} index fired: another property already owns this listing.
      if (isDuplicateKeyError(err)) throw new DuplicateError('Channel listing (owned by another property)', err.keyValue);
      throw err;
    }
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
      this.m.ChannelListing.findOne({ _id: input.channelListingId, propertyId: input.propertyId }).lean(),
      this.m.RoomType.findOne({ _id: input.roomTypeId, propertyId: input.propertyId }).lean(),
    ]);
    if (!listing) throw new NotFoundError('ChannelListing', input.channelListingId);
    if (!roomType) throw new NotFoundError('RoomType', input.roomTypeId);
    try {
      const [mapping] = await this.m.ChannelRoomMapping.create([
        {
          propertyId: input.propertyId,
          channel: listing.channel,
          channelListingId: listing._id,
          externalRoomId: input.externalRoomId ?? null,
          roomTypeId: roomType._id,
          syncAvailability: input.syncAvailability ?? true,
          syncRates: input.syncRates ?? true,
          syncRestrictions: input.syncRestrictions ?? true,
        },
      ]);
      return mapping.toObject();
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new DuplicateError('Channel room mapping', err.keyValue);
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
      this.m.ChannelRoomMapping.findOne({ _id: input.channelRoomMappingId, propertyId: input.propertyId }).lean(),
      this.m.RatePlan.findOne({ _id: input.ratePlanId, propertyId: input.propertyId }).lean(),
    ]);
    if (!mapping) throw new NotFoundError('ChannelRoomMapping', input.channelRoomMappingId);
    if (!ratePlan) throw new NotFoundError('RatePlan', input.ratePlanId);
    if (!ratePlan.roomTypeId.equals(mapping.roomTypeId)) {
      throw new DomainValidationError('Rate plan belongs to a different room type than the room mapping');
    }
    try {
      const [doc] = await this.m.ChannelRateMapping.create([
        {
          propertyId: input.propertyId,
          channel: mapping.channel,
          channelRoomMappingId: mapping._id,
          externalRatePlanId: input.externalRatePlanId,
          ratePlanId: ratePlan._id,
          markupType: input.markupType ?? MarkupType.NONE,
          markupValue: input.markupValue ?? 0,
        },
      ]);
      return doc.toObject();
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new DuplicateError('Channel rate mapping', err.keyValue);
      throw err;
    }
  }

  // ------------------------------------------------------------ inbound (channel → Tirvona)

  /** Resolve an inbound booking's listing/room to our property and room type. */
  async resolveInboundRoom(channel: ChannelCode, externalListingId: string, externalRoomId: string | null = null) {
    const listing = await this.m.ChannelListing.findOne({ channel, externalListingId }).lean();
    if (!listing) return null;
    const mapping = await this.m.ChannelRoomMapping.findOne({
      channelListingId: listing._id,
      externalRoomId,
      status: { $ne: MappingStatus.ARCHIVED },
    }).lean();
    return { listing, mapping, propertyId: listing.propertyId, roomTypeId: mapping?.roomTypeId ?? null };
  }

  async resolveInboundRatePlan(channelRoomMappingId: Id, externalRatePlanId: string): Promise<ChannelRateMapping | null> {
    return this.m.ChannelRateMapping.findOne({
      channelRoomMappingId,
      externalRatePlanId,
      status: { $ne: MappingStatus.ARCHIVED },
    }).lean();
  }

  // ------------------------------------------------------------ outbound (Tirvona → channel)

  /**
   * Channel listings that consume a room type and should receive updates.
   * Only ACTIVE mappings on CONNECTED external channels qualify. After a
   * reconnect, a full resync job is queued (see SyncJobService.enqueueFullResync).
   */
  async getOutboundTargets(propertyId: Id, roomTypeId: Id, session?: ClientSession | null): Promise<OutboundTarget[]> {
    const [mappings, connections] = await Promise.all([
      this.m.ChannelRoomMapping.find(
        { propertyId, roomTypeId, status: MappingStatus.ACTIVE },
        { channel: 1, channelListingId: 1, externalRoomId: 1, syncAvailability: 1, syncRates: 1, syncRestrictions: 1 },
      )
        .session(session ?? null)
        .lean(),
      this.m.ChannelConnection.find({ propertyId, status: ChannelConnectionStatus.CONNECTED }, { channel: 1 })
        .session(session ?? null)
        .lean(),
    ]);
    const connected = new Set(connections.map((c) => c.channel));
    return mappings
      .filter((mp) => connected.has(mp.channel) && !INTERNAL_CHANNELS.has(mp.channel))
      .map((mp) => ({
        mappingId: mp._id,
        channel: mp.channel,
        channelListingId: mp.channelListingId,
        externalRoomId: mp.externalRoomId,
        syncAvailability: mp.syncAvailability,
        syncRates: mp.syncRates,
        syncRestrictions: mp.syncRestrictions,
      }));
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
    return this.m.ChannelListing.aggregate([
      { $match: { propertyId } },
      {
        $lookup: {
          from: COLLECTION.channelRoomMappings,
          localField: '_id',
          foreignField: 'channelListingId',
          as: 'roomMappings',
          pipeline: [
            { $lookup: { from: COLLECTION.roomTypes, localField: 'roomTypeId', foreignField: '_id', as: 'roomType' } },
            { $unwind: '$roomType' },
            {
              $lookup: {
                from: COLLECTION.channelRateMappings,
                localField: '_id',
                foreignField: 'channelRoomMappingId',
                as: 'rateMappings',
                pipeline: [{ $project: { externalRatePlanId: 1, ratePlanId: 1, markupType: 1, markupValue: 1, status: 1 } }],
              },
            },
            {
              $project: {
                externalRoomId: 1,
                status: 1,
                syncAvailability: 1,
                syncRates: 1,
                syncRestrictions: 1,
                roomTypeId: 1,
                roomTypeName: '$roomType.name',
                rateMappings: 1,
              },
            },
          ],
        },
      },
      { $project: { channel: 1, externalListingId: 1, name: 1, status: 1, lastSyncedAt: 1, roomMappings: 1 } },
      { $sort: { channel: 1, name: 1 } },
    ]);
  }

  /** Listings that exist on a channel but are not yet connected to any room type. They sell nothing. */
  async findUnmappedListings(propertyId: Id) {
    return this.m.ChannelListing.aggregate([
      { $match: { propertyId, status: ChannelListingStatus.ACTIVE } },
      {
        $lookup: {
          from: COLLECTION.channelRoomMappings,
          localField: '_id',
          foreignField: 'channelListingId',
          as: 'm',
          pipeline: [{ $match: { status: { $ne: MappingStatus.ARCHIVED } } }, { $limit: 1 }],
        },
      },
      { $match: { m: { $size: 0 } } },
      { $project: { m: 0, metadata: 0 } },
    ]);
  }

  /** Room types not distributed on any external channel. */
  async findUndistributedRoomTypes(propertyId: Id) {
    return this.m.RoomType.aggregate([
      { $match: { propertyId } },
      {
        $lookup: {
          from: COLLECTION.channelRoomMappings,
          localField: '_id',
          foreignField: 'roomTypeId',
          as: 'm',
          pipeline: [{ $match: { propertyId, status: MappingStatus.ACTIVE } }, { $limit: 1 }],
        },
      },
      { $match: { m: { $size: 0 } } },
      { $project: { name: 1, slug: 1 } },
    ]);
  }

  async mappingsForRoomType(propertyId: Id, roomTypeId: Id): Promise<ChannelRoomMapping[]> {
    return this.m.ChannelRoomMapping.find({ propertyId, roomTypeId }).lean();
  }
}
