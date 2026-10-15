import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { toUuid } from '../../common/utils';
import type { AppConfig } from '../../config/configuration';
import { decryptSecret, encryptSecret } from '../../database/common/crypto';
import { addDays, formatDateOnly, todayIn } from '../../database/common/dates';
import {
  ChannelCode,
  ChannelConnectionStatus,
  MappingStatus,
  MarkupType,
  SyncEntityType,
  SyncJobType,
} from '../../database/enums';
import { ChannelError, DomainError, DomainValidationError, DuplicateError, NotFoundError } from '../../database/errors';
import type { ChannelConnection } from '../../database/db-types';
import { Db, InjectDb, j } from '../../database/kysely';
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
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly registry: ChannelAdapterRegistry,
    private readonly mappings: ChannelMappingService,
    private readonly syncJobs: SyncJobService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ------------------------------------------------------------ status

  async listChannels(propertyId: string) {
    const [connections, listingCounts, mappingCounts] = await Promise.all([
      this.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', propertyId).execute(),
      this.db.selectFrom('channelListings').select(['channel', (eb) => eb.fn.countAll<string>().as('n')]).where('propertyId', '=', propertyId).groupBy('channel').execute(),
      this.db
        .selectFrom('channelRoomMappings')
        .select(['channel', (eb) => eb.fn.countAll<string>().as('n')])
        .where('propertyId', '=', propertyId)
        .where('status', '=', MappingStatus.ACTIVE)
        .groupBy('channel')
        .execute(),
    ]);
    const conn = new Map(connections.map((c) => [c.channel, c]));
    const lc = new Map(listingCounts.map((x) => [x.channel, Number(x.n)]));
    const mc = new Map(mappingCounts.map((x) => [x.channel, Number(x.n)]));
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
        connectedAt: c?.connectedAt ?? undefined,
        lastSyncAt: c?.lastSyncAt ?? undefined,
        lastError: c?.lastError ?? undefined,
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
  async connect(user: AuthUser, meta: RequestMeta, propertyId: string, channel: string) {
    const adapter = this.registry.get(channel);
    if (!adapter.isAvailable()) this.unavailable(adapter);
    const state = randomBytes(32).toString('base64url');
    const oauth = { status: ChannelConnectionStatus.CONNECTING, oauthStateHash: sha256(state), oauthStateExpiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS), lastError: null };
    const connectionDoc = await this.db
      .insertInto('channelConnections')
      .values({ propertyId, channel: adapter.channel, ...oauth, metadata: j({}) })
      .onConflict((oc) => oc.columns(['propertyId', 'channel']).doUpdateSet(oauth))
      .returningAll()
      .executeTakeFirstOrThrow();

    const result = await adapter.connect({
      propertyId: String(propertyId),
      connectionId: connectionDoc.id,
      state,
      redirectUri: this.callbackUrl(adapter.channel),
    });
    await this.audit.log({ user, meta }, { action: 'channel.connect_start', entityType: 'ChannelConnection', entityId: connectionDoc.id, propertyId, metadata: { channel } });
    if (result.type === 'CONNECTED') {
      await this.storeCredentials(connectionDoc.id, result.credentials);
      await this.afterConnected(propertyId, adapter);
      return { status: ChannelConnectionStatus.CONNECTED };
    }
    return { status: ChannelConnectionStatus.CONNECTING, authorizationUrl: result.authorizationUrl };
  }

  /** OAuth callback: validates `state` (CSRF + binding to the connection), exchanges the code, stores tokens. */
  async completeAuthorization(channel: string, query: Record<string, string>): Promise<{ propertyId: string }> {
    const adapter = this.registry.get(channel);
    if (!query.state) throw new DomainValidationError('Missing state');
    const conn = await this.db
      .selectFrom('channelConnections')
      .selectAll()
      .where('channel', '=', adapter.channel)
      .where('oauthStateHash', '=', sha256(query.state))
      .where('oauthStateExpiresAt', '>', new Date())
      .executeTakeFirst();
    if (!conn) throw new DomainError('TOKEN_INVALID', 'Authorization state is invalid or expired; start the connection again');
    try {
      const creds = await adapter.completeConnect({
        propertyId: conn.propertyId,
        connectionId: conn.id,
        redirectUri: this.callbackUrl(adapter.channel),
        query,
      });
      await this.storeCredentials(conn.id, creds);
    } catch (err) {
      await this.db
        .updateTable('channelConnections')
        .set({ status: ChannelConnectionStatus.ERROR, lastError: (err as Error).message.slice(0, 2000), oauthStateHash: null, oauthStateExpiresAt: null })
        .where('id', '=', conn.id)
        .execute();
      throw err;
    }
    await this.audit.log({}, { action: 'channel.connected', entityType: 'ChannelConnection', entityId: conn.id, propertyId: conn.propertyId, metadata: { channel } });
    await this.afterConnected(conn.propertyId, adapter);
    return { propertyId: conn.propertyId };
  }

  async disconnect(user: AuthUser, meta: RequestMeta, propertyId: string, channel: string) {
    const adapter = this.registry.get(channel);
    const conn = await this.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', propertyId).where('channel', '=', adapter.channel).executeTakeFirst();
    if (!conn) throw new NotFoundError('Channel connection', channel);
    try {
      await adapter.disconnect(this.decrypt(conn));
    } catch (err) {
      // Remote revocation is best effort; local credentials are always wiped.
      this.logger.warn(`remote disconnect failed for ${channel}: ${(err as Error).message}`);
    }
    await this.db
      .updateTable('channelConnections')
      .set({ status: ChannelConnectionStatus.DISCONNECTED, lastError: null, oauthStateHash: null, oauthStateExpiresAt: null, accessTokenEncrypted: null, refreshTokenEncrypted: null, expiresAt: null })
      .where('id', '=', conn.id)
      .execute();
    await this.audit.log({ user, meta }, { action: 'channel.disconnect', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel } });
    return { status: ChannelConnectionStatus.DISCONNECTED };
  }

  // ------------------------------------------------------------ listings & mappings

  /** Pull listings (with their rooms and rate plans) from the channel and return them with current mappings. */
  async getListings(propertyId: string, channel: string, refresh = true) {
    const adapter = this.registry.get(channel);
    if (refresh) await this.importListings(propertyId, adapter);
    const listings = await this.mappings.listListingsWithMappings(propertyId);
    const full = await this.db.selectFrom('channelListings').select(['id', 'metadata']).where('propertyId', '=', propertyId).where('channel', '=', adapter.channel).execute();
    const meta = new Map(full.map((l) => [l.id, l.metadata ?? {}]));
    return listings
      .filter((l) => l.channel === adapter.channel)
      .map((l) => ({
        ...l,
        externalRooms: (meta.get(l.id as string) as { rooms?: unknown[] }).rooms ?? [],
        externalRatePlans: (meta.get(l.id as string) as { ratePlans?: unknown[] }).ratePlans ?? [],
      }));
  }

  async importListings(propertyId: string, adapter: ChannelAdapter): Promise<number> {
    const { connection, creds } = await this.credentials(propertyId, adapter);
    const listings = await adapter.getListings(creds);
    for (const l of listings) {
      const [rooms, ratePlans] = await Promise.all([adapter.getRoomTypes(creds, l.externalListingId), adapter.getRates(creds, l.externalListingId)]);
      await this.mappings.upsertListing({
        propertyId,
        channel: adapter.channel,
        externalListingId: l.externalListingId,
        name: l.name,
        channelConnectionId: connection.id,
        metadata: { ...(l.metadata ?? {}), rooms, ratePlans },
      });
    }
    await this.db.updateTable('channelListings').set({ lastSyncedAt: new Date() }).where('propertyId', '=', propertyId).where('channel', '=', adapter.channel).execute();
    return listings.length;
  }

  /**
   * Map listings / external rooms to room types and external rate plans to
   * rate plans. Re-posting an identical mapping is idempotent. Mapping a
   * listing that is already mapped to a different room type is a 409. New
   * mappings get a full push of availability, rates and restrictions.
   */
  async createMappings(user: AuthUser, meta: RequestMeta, propertyId: string, channel: string, dto: CreateMappingsDto) {
    const adapter = this.registry.get(channel);
    const results = [];
    for (const input of dto.mappings) {
      const listing = await this.db.selectFrom('channelListings').selectAll().where('propertyId', '=', propertyId).where('channel', '=', adapter.channel).where('externalListingId', '=', input.externalListingId).executeTakeFirst();
      if (!listing) throw new NotFoundError(`${channel} listing (import listings first)`, input.externalListingId);
      const externalRoomId = input.externalRoomId ?? null;
      const knownRooms = (listing.metadata as { rooms?: { externalRoomId: string | null }[] }).rooms;
      if (knownRooms && !knownRooms.some((r) => r.externalRoomId === externalRoomId)) {
        throw new DomainValidationError(`Listing ${input.externalListingId} has no room ${externalRoomId ?? '(unit)'}`);
      }
      const roomTypeId = toUuid(input.roomTypeId, 'roomTypeId');

      let mappingQ = this.db.selectFrom('channelRoomMappings').selectAll().where('channelListingId', '=', listing.id);
      mappingQ = externalRoomId === null ? mappingQ.where('externalRoomId', 'is', null) : mappingQ.where('externalRoomId', '=', externalRoomId);
      let mapping = await mappingQ.executeTakeFirst();
      let created = false;
      if (mapping && mapping.roomTypeId !== roomTypeId) {
        throw new DuplicateError('Channel room mapping (listing/room is mapped to another room type)', { externalListingId: input.externalListingId, externalRoomId });
      }
      if (!mapping) {
        mapping = await this.mappings.mapRoom({
          propertyId,
          channelListingId: listing.id,
          roomTypeId,
          externalRoomId,
          syncAvailability: input.syncAvailability,
          syncRates: input.syncRates,
          syncRestrictions: input.syncRestrictions,
        });
        created = true;
      } else if (mapping.status !== MappingStatus.ACTIVE) {
        await this.db.updateTable('channelRoomMappings').set({ status: MappingStatus.ACTIVE }).where('id', '=', mapping.id).execute();
      }

      let rateMappings = 0;
      for (const rp of input.ratePlans ?? []) {
        const existing = await this.db.selectFrom('channelRateMappings').select('id').where('channelRoomMappingId', '=', mapping.id).where('externalRatePlanId', '=', rp.externalRatePlanId).executeTakeFirst();
        if (existing) {
          await this.db
            .updateTable('channelRateMappings')
            .set({ ratePlanId: toUuid(rp.ratePlanId, 'ratePlanId'), markupType: rp.markupType ?? MarkupType.NONE, markupValue: rp.markupValue ?? 0, status: MappingStatus.ACTIVE })
            .where('id', '=', existing.id)
            .execute();
        } else {
          await this.mappings.mapRatePlan({
            propertyId,
            channelRoomMappingId: mapping.id,
            externalRatePlanId: rp.externalRatePlanId,
            ratePlanId: toUuid(rp.ratePlanId, 'ratePlanId'),
            markupType: rp.markupType,
            markupValue: rp.markupValue,
          });
        }
        rateMappings++;
      }
      await this.queueMappingResync(propertyId, adapter.channel, listing.id, roomTypeId);
      await this.audit.log({ user, meta }, {
        action: created ? 'channel.mapping_create' : 'channel.mapping_update',
        entityType: 'ChannelRoomMapping',
        entityId: mapping.id,
        propertyId,
        after: { channel, externalListingId: input.externalListingId, externalRoomId, roomTypeId, rateMappings },
      });
      results.push({ mappingId: mapping.id, externalListingId: input.externalListingId, externalRoomId, roomTypeId, created, rateMappings });
    }
    void this.outbox.flush();
    return results;
  }

  async removeMapping(user: AuthUser, meta: RequestMeta, propertyId: string, mappingId: string) {
    const mapping = await this.db.updateTable('channelRoomMappings').set({ status: MappingStatus.ARCHIVED }).where('id', '=', toUuid(mappingId)).where('propertyId', '=', propertyId).returning('id').executeTakeFirst();
    if (!mapping) throw new NotFoundError('Channel mapping', mappingId);
    await this.db.updateTable('channelRateMappings').set({ status: MappingStatus.ARCHIVED }).where('channelRoomMappingId', '=', mapping.id).execute();
    await this.audit.log({ user, meta }, { action: 'channel.mapping_remove', entityType: 'ChannelRoomMapping', entityId: mappingId, propertyId });
    return { ok: true };
  }

  /** Manual full resync: availability, rates and restrictions for the whole horizon, for every mapping. */
  async triggerSync(user: AuthUser, meta: RequestMeta, propertyId: string, channel: string) {
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
  async credentials(propertyId: string, adapter: ChannelAdapter): Promise<{ connection: ChannelConnection; creds: ChannelCredentials }> {
    const connection = await this.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', propertyId).where('channel', '=', adapter.channel).executeTakeFirst();
    if (!connection || connection.status !== ChannelConnectionStatus.CONNECTED) {
      throw new ChannelError('CHANNEL_NOT_CONNECTED', `${adapter.displayName} is not connected for this property`, false);
    }
    let creds = this.decrypt(connection);
    if (creds.expiresAt && creds.expiresAt.getTime() < Date.now() + 60_000 && adapter.refreshCredentials) {
      try {
        creds = await adapter.refreshCredentials(creds);
        await this.storeCredentials(connection.id, creds);
      } catch (err) {
        await this.db.updateTable('channelConnections').set({ status: ChannelConnectionStatus.EXPIRED, lastError: (err as Error).message.slice(0, 2000) }).where('id', '=', connection.id).execute();
        throw new ChannelError('CHANNEL_NOT_CONNECTED', `${adapter.displayName} authorization expired; reconnect the channel`, false);
      }
    }
    return { connection, creds };
  }

  private decrypt(c: ChannelConnection): ChannelCredentials {
    return {
      accessToken: c.accessTokenEncrypted ? decryptSecret(c.accessTokenEncrypted) : undefined,
      refreshToken: c.refreshTokenEncrypted ? decryptSecret(c.refreshTokenEncrypted) : undefined,
      expiresAt: c.expiresAt ?? undefined,
      externalAccountId: c.externalAccountId ?? undefined,
      metadata: c.metadata ?? {},
    };
  }

  private async storeCredentials(connectionId: string, creds: ChannelCredentials): Promise<void> {
    await this.db
      .updateTable('channelConnections')
      .set({
        status: ChannelConnectionStatus.CONNECTED,
        ...(creds.accessToken ? { accessTokenEncrypted: encryptSecret(creds.accessToken) } : {}),
        ...(creds.refreshToken ? { refreshTokenEncrypted: encryptSecret(creds.refreshToken) } : {}),
        ...(creds.expiresAt ? { expiresAt: creds.expiresAt } : {}),
        ...(creds.externalAccountId ? { externalAccountId: creds.externalAccountId } : {}),
        connectedAt: new Date(),
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        lastError: null,
      })
      .where('id', '=', connectionId)
      .execute();
  }

  private async afterConnected(propertyId: string, adapter: ChannelAdapter) {
    try {
      await this.importListings(propertyId, adapter);
    } catch (err) {
      this.logger.warn(`listing import after connect failed for ${adapter.channel}: ${(err as Error).message}`);
    }
    await this.syncJobs.enqueueFullResync(propertyId, adapter.channel);
    void this.outbox.flush();
  }

  private async queueMappingResync(propertyId: string, channel: ChannelCode, channelListingId: string, roomTypeId: string) {
    const property = await this.db.selectFrom('properties').select(['timezone', 'bookingHorizonDays']).where('id', '=', propertyId).executeTakeFirstOrThrow();
    const from = todayIn(property.timezone);
    const to = addDays(from, property.bookingHorizonDays);
    await this.db
      .insertInto('syncJobs')
      .values(
        [SyncJobType.INVENTORY, SyncJobType.RATES, SyncJobType.RESTRICTIONS].map((type) => ({
          propertyId,
          channel,
          channelListingId,
          roomTypeId,
          type,
          entityType: SyncEntityType.ROOM_TYPE,
          entityId: roomTypeId,
          dateFrom: formatDateOnly(from) as never,
          dateTo: formatDateOnly(to) as never,
        })),
      )
      .execute();
  }

  callbackUrl(channel: string): string {
    return `${this.config.get('apiUrl', { infer: true })}/channels/oauth/${channel}/callback`;
  }

  private unavailable(adapter: ChannelAdapter): never {
    throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', `${adapter.displayName} integration is not available on this deployment`, false);
  }
}
