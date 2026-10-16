import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import type { ChannelConnection } from '../../database/db-types';
import { ChannelCode, INTERNAL_CHANNELS, ProviderProtocol, ProviderStatus } from '../../database/enums';
import { ChannelError, DomainError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { AgodaAdapter } from './agoda/agoda.adapter';
import { AirbnbAdapter } from './airbnb/airbnb.adapter';
import { BookingComAdapter } from './booking-com/booking-com.adapter';
import type { ChannelAdapter } from './interfaces/channel-adapter.interface';
import { MockChannelAdapter } from './mock/mock-channel.adapter';
import { ConnectionSecretsService } from './providers/connection-secrets.service';
import { GenericRestAdapter } from './providers/generic-rest.adapter';
import { type IcalFeed, IcalAdapter } from './providers/ical.adapter';
import { type ProviderDefinition, validateDefinition } from './providers/provider-definition';

/**
 * Resolves which adapter serves a channel.
 *
 *  - Built-in channels (Airbnb, Booking.com, Agoda, the mock) are code adapters, registered here exactly as before.
 *  - With CHANNEL_PROVIDERS_ENABLED, any other provider code is a row in `channel_providers`; a connection to it is served by a
 *    GenericRestAdapter built from the provider version that connection pins, with that connection's own decrypted credentials.
 *
 * `get(channel)` keeps its old meaning (built-in code adapters, synchronous). Everything that knows which property or connection
 * it is acting for uses `forProperty` / `forConnection`, which also resolve configured providers.
 */
@Injectable()
export class ChannelAdapterRegistry {
  private readonly adapters: Map<string, ChannelAdapter>;
  /** Published versions are immutable, so a validated definition can be cached by version id. */
  private readonly definitions = new Map<string, ProviderDefinition>();

  constructor(
    airbnb: AirbnbAdapter,
    bookingCom: BookingComAdapter,
    agoda: AgodaAdapter,
    mock: MockChannelAdapter,
    @InjectDb() private readonly db: Db,
    private readonly secrets: ConnectionSecretsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.adapters = new Map<string, ChannelAdapter>([
      [ChannelCode.AIRBNB, airbnb],
      [ChannelCode.BOOKING_COM, bookingCom],
      [ChannelCode.AGODA, agoda],
      ...(mock.isAvailable() ? ([[ChannelCode.MOCK, mock]] as const) : []),
    ]);
  }

  get providersEnabled(): boolean {
    return this.config.get('channelProviders', { infer: true }).enabled;
  }

  /** The built-in code adapter of a channel. */
  get(channel: string): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      const internal = INTERNAL_CHANNELS.has(channel as ChannelCode);
      throw new DomainError(
        'CHANNEL_NOT_SUPPORTED',
        internal ? `${channel} reads Tirvona inventory directly and needs no connection` : `Unknown channel ${channel}`,
      );
    }
    return adapter;
  }

  isBuiltIn(channel: string): boolean {
    return this.adapters.has(channel) || INTERNAL_CHANNELS.has(channel as ChannelCode) || channel === ChannelCode.MOCK || channel === ChannelCode.OTHER;
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  /** The adapter to use for this property's connection to `channel`. */
  async forProperty(propertyId: string, channel: string): Promise<ChannelAdapter> {
    if (this.adapters.has(channel) || !this.providersEnabled) return this.get(channel);
    const conn = await this.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', propertyId).where('channel', '=', channel).executeTakeFirst();
    if (!conn) {
      const provider = await this.db.selectFrom('channelProviders').select('protocol').where('code', '=', channel).where('status', '=', ProviderStatus.ACTIVE).executeTakeFirst();
      if (provider?.protocol === ProviderProtocol.REST_JSON || provider?.protocol === ProviderProtocol.ICAL) {
        throw new ChannelError('CHANNEL_NOT_CONNECTED', `${channel} is not connected for this property`, false);
      }
      return this.get(channel); // unknown code: the usual CHANNEL_NOT_SUPPORTED
    }
    return this.forConnection(conn);
  }

  async forConnection(conn: Pick<ChannelConnection, 'id' | 'propertyId' | 'channel' | 'providerId' | 'providerVersionId' | 'externalAccountId' | 'metadata'>): Promise<ChannelAdapter> {
    const builtIn = this.adapters.get(conn.channel);
    if (builtIn) return builtIn;
    if (!this.providersEnabled) return this.get(conn.channel);
    const provider = await this.db.selectFrom('channelProviders').selectAll().where('code', '=', conn.channel).executeTakeFirst();
    if (!provider || (provider.protocol !== ProviderProtocol.REST_JSON && provider.protocol !== ProviderProtocol.ICAL) || provider.status !== ProviderStatus.ACTIVE) {
      throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', `${conn.channel} is not available`, false);
    }
    if (provider.protocol === ProviderProtocol.ICAL) return this.icalAdapter(conn, provider.code, provider.name);
    const versionId = conn.providerVersionId ?? provider.currentVersionId;
    if (!versionId) throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', `${provider.name} has no published version`, false);
    const def = await this.definition(versionId);
    const env = (conn.metadata as { environment?: string } | null)?.environment === 'sandbox' ? 'sandbox' : 'production';
    return new GenericRestAdapter(def, {
      providerCode: provider.code,
      displayName: provider.name,
      environment: env,
      connectionId: conn.id,
      externalAccountId: conn.externalAccountId,
      secrets: await this.secrets.load(conn.id),
      allowPrivate: this.config.get('channelProviders', { infer: true }).allowPrivateTargets,
    });
  }

  private async icalAdapter(conn: Pick<ChannelConnection, 'id' | 'propertyId'>, code: string, name: string): Promise<ChannelAdapter> {
    const secrets = (await this.secrets.load(conn.id)) as { FEED_URLS?: string };
    let feeds: IcalFeed[] = [];
    try {
      feeds = secrets.FEED_URLS ? (JSON.parse(secrets.FEED_URLS) as IcalFeed[]) : [];
    } catch {
      feeds = [];
    }
    const property = await this.db.selectFrom('properties').select('currency').where('id', '=', conn.propertyId).executeTakeFirstOrThrow();
    return new IcalAdapter({ providerCode: code, displayName: name, connectionId: conn.id, feeds, currency: property.currency, allowPrivate: this.config.get('channelProviders', { infer: true }).allowPrivateTargets });
  }

  /** Inbound webhooks of configured providers address a connection by its random key. */
  async forWebhookKey(webhookKey: string): Promise<{ adapter: ChannelAdapter; connection: ChannelConnection } | null> {
    if (!this.providersEnabled) return null;
    const connection = await this.db.selectFrom('channelConnections').selectAll().where('webhookKey', '=', webhookKey).executeTakeFirst();
    if (!connection || this.adapters.has(connection.channel)) return null;
    return { adapter: await this.forConnection(connection), connection };
  }

  private async definition(versionId: string): Promise<ProviderDefinition> {
    const cached = this.definitions.get(versionId);
    if (cached) return cached;
    const v = await this.db.selectFrom('channelProviderVersions').select(['definition', 'status']).where('id', '=', versionId).executeTakeFirst();
    if (!v || (v.status !== 'PUBLISHED' && v.status !== 'RETIRED')) throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', 'The provider version is not published', false);
    // Re-validated on load: a row edited behind our back must not reach the engine.
    const checked = validateDefinition(v.definition, { allowInsecureHosts: this.config.get('channelProviders', { infer: true }).allowPrivateTargets });
    if (!checked.ok || !checked.definition) throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', 'The provider definition failed validation', false);
    if (this.definitions.size > 200) this.definitions.clear();
    this.definitions.set(versionId, checked.definition);
    return checked.definition;
  }
}
