import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { Connection, Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { toObjectId } from '../../common/utils';
import type { AppConfig } from '../../config/configuration';
import { decryptSecret, encryptSecret } from '../../database/common/crypto';
import { addDays, todayIn } from '../../database/common/dates';
import {
  ChannelCode,
  ChannelConnectionStatus,
  MappingStatus,
  MarkupType,
  SyncEntityType,
  SyncJobType,
} from '../../database/enums';
import { ChannelError, DomainError, DomainValidationError, DuplicateError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { ChannelConnection } from '../../database/schemas/channel.schema';
import { ChannelMappingService } from '../../database/services/channel-mapping.service';
import { SyncJobService } from '../../database/services/sync-job.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import { ChannelAdapterRegistry } from './channel-registry';
import type { CreateMappingsDto } from './channels.dto';
import type { ChannelAdapter, ChannelCredentials } from './interfaces/channel-adapter.interface';

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Channel connections, listing import, mappings and manual sync. Credentials
 * are encrypted at rest and decrypted only in memory for a call. Everything
 * channel-specific is delegated to the adapter.
 */
@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly registry: ChannelAdapterRegistry,
    private readonly mappings: ChannelMappingService,
    private readonly syncJobs: SyncJobService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.m = getModels(connection);
  }

  // ------------------------------------------------------------ status

  async listChannels(propertyId: Types.ObjectId) {
    const [connections, listingCounts, mappingCounts] = await Promise.all([
      this.m.ChannelConnection.find({ propertyId }).lean(),
      this.m.ChannelListing.aggregate<{ _id: string; n: number }>([{ $match: { propertyId } }, { $group: { _id: '$channel', n: { $sum: 1 } } }]),
      this.m.ChannelRoomMapping.aggregate<{ _id: string; n: number }>([
        { $match: { propertyId, status: MappingStatus.ACTIVE } },
        { $group: { _id: '$channel', n: { $sum: 1 } } },
      ]),
    ]);
    const conn = new Map(connections.map((c) => [c.channel, c]));
    const lc = new Map(listingCounts.map((x) => [x._id, x.n]));
    const mc = new Map(mappingCounts.map((x) => [x._id, x.n]));
    const internal = [ChannelCode.TIRVONA, ChannelCode.DIRECT].map((channel) => ({
      channel,
      displayName: channel === ChannelCode.TIRVONA ? 'Tirvona marketplace' : 'Direct booking engine',
      internal: true,
      available: true,
      status: 'INTERNAL',
      listings: 0,
      mappings: 0,
    }));
    const external = this.registry.list().map((a) => {
      const c = conn.get(a.channel);
      return {
        channel: a.channel,
        displayName: a.displayName,
        internal: false,
        available: a.isAvailable(),
        status: c?.status ?? ChannelConnectionStatus.DISCONNECTED,
        connectedAt: c?.connectedAt,
        lastSyncAt: c?.lastSyncAt,
        lastError: c?.lastError,
        listings: lc.get(a.channel) ?? 0,
        mappings: mc.get(a.channel) ?? 0,
      };
    });
    return [...internal, ...external];
  }

  // ------------------------------------------------------------ connect / disconnect

  /**
   * Starts the channel's official authorization flow. The owner is sent to
   * `authorizationUrl` (the channel's consent page) and comes back to our
   * callback with a code. Owners never type API keys into Tirvona.
   */
  async connect(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, channel: string) {
    const adapter = this.registry.get(channel);
    if (!adapter.isAvailable()) this.unavailable(adapter);
    const state = randomBytes(32).toString('base64url');
    const connectionDoc = await this.m.ChannelConnection.findOneAndUpdate(
      { propertyId, channel: adapter.channel },
      {
        $set: {
          status: ChannelConnectionStatus.CONNECTING,
          oauthStateHash: sha256(state),
          oauthStateExpiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
          lastError: null,
        },
        $setOnInsert: { metadata: {} },
      },
      { upsert: true, new: true },
    ).lean();

    const result = await adapter.connect({
      propertyId: String(propertyId),
      connectionId: String(connectionDoc._id),
      state,
      redirectUri: this.callbackUrl(adapter.channel),
    });
    await this.audit.log({ user, meta }, { action: 'channel.connect_start', entityType: 'ChannelConnection', entityId: connectionDoc._id, propertyId, metadata: { channel } });
    if (result.type === 'CONNECTED') {
      await this.storeCredentials(connectionDoc._id, result.credentials);
      await this.afterConnected(propertyId, adapter);
      return { status: ChannelConnectionStatus.CONNECTED };
    }
    return { status: ChannelConnectionStatus.CONNECTING, authorizationUrl: result.authorizationUrl };
  }

  /** OAuth callback: validates `state` (CSRF + binding to the connection), exchanges the code, stores tokens. */
  async completeAuthorization(channel: string, query: Record<string, string>): Promise<{ propertyId: Types.ObjectId }> {
    const adapter = this.registry.get(channel);
    if (!query.state) throw new DomainValidationError('Missing state');
    const conn = await this.m.ChannelConnection.findOne({
      channel: adapter.channel,
      oauthStateHash: sha256(query.state),
      oauthStateExpiresAt: { $gt: new Date() },
    }).lean();
    if (!conn) throw new DomainError('TOKEN_INVALID', 'Authorization state is invalid or expired; start the connection again');
    try {
      const creds = await adapter.completeConnect({
        propertyId: String(conn.propertyId),
        connectionId: String(conn._id),
        redirectUri: this.callbackUrl(adapter.channel),
        query,
      });
      await this.storeCredentials(conn._id, creds);
    } catch (err) {
      await this.m.ChannelConnection.updateOne(
        { _id: conn._id },
        { $set: { status: ChannelConnectionStatus.ERROR, lastError: (err as Error).message.slice(0, 2000), oauthStateHash: null, oauthStateExpiresAt: null } },
      );
      throw err;
    }
    await this.audit.log({}, { action: 'channel.connected', entityType: 'ChannelConnection', entityId: conn._id, propertyId: conn.propertyId, metadata: { channel } });
    await this.afterConnected(conn.propertyId, adapter);
    return { propertyId: conn.propertyId };
  }

  async disconnect(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, channel: string) {
    const adapter = this.registry.get(channel);
    const conn = await this.m.ChannelConnection.findOne({ propertyId, channel: adapter.channel })
      .select('+accessTokenEncrypted +refreshTokenEncrypted')
      .lean();
    if (!conn) throw new NotFoundError('Channel connection', channel);
    try {
      await adapter.disconnect(this.decrypt(conn));
    } catch (err) {
      // Remote revocation is best effort; local credentials are always wiped.
      this.logger.warn(`remote disconnect failed for ${channel}: ${(err as Error).message}`);
    }
    await this.m.ChannelConnection.updateOne(
      { _id: conn._id },
      {
        $set: { status: ChannelConnectionStatus.DISCONNECTED, lastError: null, oauthStateHash: null, oauthStateExpiresAt: null },
        $unset: { accessTokenEncrypted: 1, refreshTokenEncrypted: 1, expiresAt: 1 },
      },
    );
    await this.audit.log({ user, meta }, { action: 'channel.disconnect', entityType: 'ChannelConnection', entityId: conn._id, propertyId, metadata: { channel } });
    return { status: ChannelConnectionStatus.DISCONNECTED };
  }

  // ------------------------------------------------------------ listings & mappings

  /** Pull listings (with their rooms and rate plans) from the channel and return them with current mappings. */
  async getListings(propertyId: Types.ObjectId, channel: string, refresh = true) {
    const adapter = this.registry.get(channel);
    if (refresh) await this.importListings(propertyId, adapter);
    const listings = await this.mappings.listListingsWithMappings(propertyId);
    const full = await this.m.ChannelListing.find({ propertyId, channel: adapter.channel }, { metadata: 1 }).lean();
    const meta = new Map(full.map((l) => [String(l._id), l.metadata ?? {}]));
    return listings
      .filter((l) => l.channel === adapter.channel)
      .map((l) => ({
        ...l,
        externalRooms: (meta.get(String(l._id)) as { rooms?: unknown[] }).rooms ?? [],
        externalRatePlans: (meta.get(String(l._id)) as { ratePlans?: unknown[] }).ratePlans ?? [],
      }));
  }

  async importListings(propertyId: Types.ObjectId, adapter: ChannelAdapter): Promise<number> {
    const { connection, creds } = await this.credentials(propertyId, adapter);
    const listings = await adapter.getListings(creds);
    for (const l of listings) {
      const [rooms, ratePlans] = await Promise.all([adapter.getRoomTypes(creds, l.externalListingId), adapter.getRates(creds, l.externalListingId)]);
      await this.mappings.upsertListing({
        propertyId,
        channel: adapter.channel,
        externalListingId: l.externalListingId,
        name: l.name,
        channelConnectionId: connection._id,
        metadata: { ...(l.metadata ?? {}), rooms, ratePlans },
      });
    }
    await this.m.ChannelListing.updateMany({ propertyId, channel: adapter.channel }, { $set: { lastSyncedAt: new Date() } });
    return listings.length;
  }

  /**
   * Map listings / external rooms to room types and external rate plans to
   * rate plans. Re-posting an identical mapping is idempotent. Mapping a
   * listing that is already mapped to a different room type is a 409. New
   * mappings get a full push of availability, rates and restrictions.
   */
  async createMappings(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, channel: string, dto: CreateMappingsDto) {
    const adapter = this.registry.get(channel);
    const results = [];
    for (const input of dto.mappings) {
      const listing = await this.m.ChannelListing.findOne({ propertyId, channel: adapter.channel, externalListingId: input.externalListingId }).lean();
      if (!listing) throw new NotFoundError(`${channel} listing (import listings first)`, input.externalListingId);
      const externalRoomId = input.externalRoomId ?? null;
      const knownRooms = (listing.metadata as { rooms?: { externalRoomId: string | null }[] }).rooms;
      if (knownRooms && !knownRooms.some((r) => r.externalRoomId === externalRoomId)) {
        throw new DomainValidationError(`Listing ${input.externalListingId} has no room ${externalRoomId ?? '(unit)'}`);
      }
      const roomTypeId = toObjectId(input.roomTypeId, 'roomTypeId');

      let mapping = await this.m.ChannelRoomMapping.findOne({ channelListingId: listing._id, externalRoomId }).lean();
      let created = false;
      if (mapping && !mapping.roomTypeId.equals(roomTypeId)) {
        throw new DuplicateError('Channel room mapping (listing/room is mapped to another room type)', { externalListingId: input.externalListingId, externalRoomId });
      }
      if (!mapping) {
        mapping = await this.mappings.mapRoom({
          propertyId,
          channelListingId: listing._id,
          roomTypeId,
          externalRoomId,
          syncAvailability: input.syncAvailability,
          syncRates: input.syncRates,
          syncRestrictions: input.syncRestrictions,
        });
        created = true;
      } else if (mapping.status !== MappingStatus.ACTIVE) {
        await this.m.ChannelRoomMapping.updateOne({ _id: mapping._id }, { $set: { status: MappingStatus.ACTIVE } });
      }

      let rateMappings = 0;
      for (const rp of input.ratePlans ?? []) {
        const existing = await this.m.ChannelRateMapping.findOne({ channelRoomMappingId: mapping._id, externalRatePlanId: rp.externalRatePlanId }).lean();
        if (existing) {
          await this.m.ChannelRateMapping.updateOne(
            { _id: existing._id },
            { $set: { ratePlanId: toObjectId(rp.ratePlanId, 'ratePlanId'), markupType: rp.markupType ?? MarkupType.NONE, markupValue: rp.markupValue ?? 0, status: MappingStatus.ACTIVE } },
            { runValidators: true },
          );
        } else {
          await this.mappings.mapRatePlan({
            propertyId,
            channelRoomMappingId: mapping._id,
            externalRatePlanId: rp.externalRatePlanId,
            ratePlanId: toObjectId(rp.ratePlanId, 'ratePlanId'),
            markupType: rp.markupType,
            markupValue: rp.markupValue,
          });
        }
        rateMappings++;
      }
      await this.queueMappingResync(propertyId, adapter.channel, listing._id, roomTypeId);
      await this.audit.log({ user, meta }, {
        action: created ? 'channel.mapping_create' : 'channel.mapping_update',
        entityType: 'ChannelRoomMapping',
        entityId: mapping._id,
        propertyId,
        after: { channel, externalListingId: input.externalListingId, externalRoomId, roomTypeId, rateMappings },
      });
      results.push({ mappingId: mapping._id, externalListingId: input.externalListingId, externalRoomId, roomTypeId, created, rateMappings });
    }
    void this.outbox.flush();
    return results;
  }

  async removeMapping(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, mappingId: Types.ObjectId) {
    const mapping = await this.m.ChannelRoomMapping.findOneAndUpdate({ _id: mappingId, propertyId }, { $set: { status: MappingStatus.ARCHIVED } }, { new: true }).lean();
    if (!mapping) throw new NotFoundError('Channel mapping', mappingId);
    await this.m.ChannelRateMapping.updateMany({ channelRoomMappingId: mappingId }, { $set: { status: MappingStatus.ARCHIVED } });
    await this.audit.log({ user, meta }, { action: 'channel.mapping_remove', entityType: 'ChannelRoomMapping', entityId: mappingId, propertyId });
    return { ok: true };
  }

  /** Manual full resync: availability, rates and restrictions for the whole horizon, for every mapping. */
  async triggerSync(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, channel: string) {
    const adapter = this.registry.get(channel);
    await this.credentials(propertyId, adapter); // must be connected
    const queued = await this.syncJobs.enqueueFullResync(propertyId, adapter.channel);
    await this.audit.log({ user, meta }, { action: 'channel.manual_sync', entityType: 'Property', entityId: propertyId, propertyId, metadata: { channel, queued } });
    void this.outbox.flush();
    return { queued };
  }

  // ------------------------------------------------------------ credentials

  /**
   * Decrypted credentials for a CONNECTED channel, refreshed first if the
   * access token is about to expire. Callers must never persist or log them.
   */
  async credentials(propertyId: Types.ObjectId, adapter: ChannelAdapter): Promise<{ connection: ChannelConnection; creds: ChannelCredentials }> {
    const connection = await this.m.ChannelConnection.findOne({ propertyId, channel: adapter.channel })
      .select('+accessTokenEncrypted +refreshTokenEncrypted')
      .lean();
    if (!connection || connection.status !== ChannelConnectionStatus.CONNECTED) {
      throw new ChannelError('CHANNEL_NOT_CONNECTED', `${adapter.displayName} is not connected for this property`, false);
    }
    let creds = this.decrypt(connection);
    if (creds.expiresAt && creds.expiresAt.getTime() < Date.now() + 60_000 && adapter.refreshCredentials) {
      try {
        creds = await adapter.refreshCredentials(creds);
        await this.storeCredentials(connection._id, creds);
      } catch (err) {
        await this.m.ChannelConnection.updateOne({ _id: connection._id }, { $set: { status: ChannelConnectionStatus.EXPIRED, lastError: (err as Error).message.slice(0, 2000) } });
        throw new ChannelError('CHANNEL_NOT_CONNECTED', `${adapter.displayName} authorization expired; reconnect the channel`, false);
      }
    }
    return { connection, creds };
  }

  private decrypt(c: ChannelConnection): ChannelCredentials {
    return {
      accessToken: c.accessTokenEncrypted ? decryptSecret(c.accessTokenEncrypted) : undefined,
      refreshToken: c.refreshTokenEncrypted ? decryptSecret(c.refreshTokenEncrypted) : undefined,
      expiresAt: c.expiresAt,
      externalAccountId: c.externalAccountId,
      metadata: c.metadata ?? {},
    };
  }

  private async storeCredentials(connectionId: Types.ObjectId, creds: ChannelCredentials): Promise<void> {
    await this.m.ChannelConnection.updateOne(
      { _id: connectionId },
      {
        $set: {
          status: ChannelConnectionStatus.CONNECTED,
          ...(creds.accessToken ? { accessTokenEncrypted: encryptSecret(creds.accessToken) } : {}),
          ...(creds.refreshToken ? { refreshTokenEncrypted: encryptSecret(creds.refreshToken) } : {}),
          ...(creds.expiresAt ? { expiresAt: creds.expiresAt } : {}),
          ...(creds.externalAccountId ? { externalAccountId: creds.externalAccountId } : {}),
          connectedAt: new Date(),
          oauthStateHash: null,
          oauthStateExpiresAt: null,
          lastError: null,
        },
      },
      { runValidators: true },
    );
  }

  private async afterConnected(propertyId: Types.ObjectId, adapter: ChannelAdapter) {
    try {
      await this.importListings(propertyId, adapter);
    } catch (err) {
      this.logger.warn(`listing import after connect failed for ${adapter.channel}: ${(err as Error).message}`);
    }
    await this.syncJobs.enqueueFullResync(propertyId, adapter.channel);
    void this.outbox.flush();
  }

  private async queueMappingResync(propertyId: Types.ObjectId, channel: ChannelCode, channelListingId: Types.ObjectId, roomTypeId: Types.ObjectId) {
    const property = await this.m.Property.findById(propertyId, { timezone: 1, bookingHorizonDays: 1 }).lean();
    const from = todayIn(property!.timezone);
    const to = addDays(from, property!.bookingHorizonDays);
    await this.m.SyncJob.insertMany(
      [SyncJobType.INVENTORY, SyncJobType.RATES, SyncJobType.RESTRICTIONS].map((type) => ({
        propertyId,
        channel,
        channelListingId,
        roomTypeId,
        type,
        entityType: SyncEntityType.ROOM_TYPE,
        entityId: roomTypeId,
        dateFrom: from,
        dateTo: to,
      })),
    );
  }

  callbackUrl(channel: string): string {
    return `${this.config.get('apiUrl', { infer: true })}/channels/oauth/${channel}/callback`;
  }

  private unavailable(adapter: ChannelAdapter): never {
    throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', `${adapter.displayName} integration is not available on this deployment`, false);
  }
}
