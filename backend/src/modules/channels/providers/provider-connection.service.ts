import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser, RequestMeta } from '../../../common/auth/auth-user';
import type { AppConfig } from '../../../config/configuration';
import type { ChannelConnection } from '../../../database/db-types';
import { ChannelConnectionStatus, ConnectionSecretKind, ProviderProtocol, ProviderStatus, ProviderVisibility } from '../../../database/enums';
import { ChannelError, DomainValidationError, NotFoundError } from '../../../database/errors';
import { Db, InjectDb, j } from '../../../database/kysely';
import { AuditLogger } from '../../audit/audit.logger';
import { ChannelAdapterRegistry } from '../channel-registry';
import { ChannelsService } from '../channels.service';
import { ConnectionSecretsService, SECRET_KINDS_FOR_AUTH } from './connection-secrets.service';
import { GenericRestAdapter } from './generic-rest.adapter';
import { feedIdFor, type IcalAdapter, type IcalFeed } from './ical.adapter';
import type { ProviderDefinition } from './provider-definition';
import { validateDefinition } from './provider-definition';
import { redactText } from './provider-engine';

export interface CredentialInput {
  API_KEY?: string;
  BEARER_TOKEN?: string;
  BASIC_USERNAME?: string;
  BASIC_PASSWORD?: string;
  SIGNING_SECRET?: string;
  WEBHOOK_SECRET?: string;
}

export interface ConnectInput {
  credentials?: CredentialInput;
  /** iCal providers: the calendar addresses to read. Each address is itself a secret and is stored encrypted. */
  feeds?: { name: string; url: string }[];
  environment?: 'production' | 'sandbox';
  externalAccountId?: string;
  pollIntervalSeconds?: number | null;
}

const MIN_POLL_SECONDS = 60;

/**
 * The lifecycle of a connection to a configuration-driven provider: connect with credentials, verify, rotate credentials, change
 * settings, test, describe. A connection is CONNECTED only after the provider's own read-only health call has succeeded with the
 * credentials the owner entered; entering credentials is never enough.
 */
@Injectable()
export class ProviderConnectionService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly registry: ChannelAdapterRegistry,
    private readonly secrets: ConnectionSecretsService,
    private readonly channels: ChannelsService,
    private readonly audit: AuditLogger,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  webhookUrl(webhookKey: string | null): string | null {
    return webhookKey ? `${this.config.get('apiUrl', { infer: true })}/webhooks/c/${webhookKey}` : null;
  }

  async connect(user: AuthUser, meta: RequestMeta, propertyId: string, channel: string, input: ConnectInput) {
    const row = await this.providerRow(user, channel);
    if (row.protocol === ProviderProtocol.ICAL) return this.connectIcal(user, meta, propertyId, row, input);
    const { provider, def } = await this.loadProvider(user, channel);
    const credentials = input.credentials ?? {};
    this.requireCredentials(def, credentials);
    const environment = input.environment ?? 'production';
    if (environment === 'sandbox' && !def.environments.sandbox) throw new DomainValidationError(`${provider.name} has no sandbox environment`);
    const poll = this.pollSetting(def, input.pollIntervalSeconds);

    const base = {
      status: ChannelConnectionStatus.CONNECTING,
      providerId: provider.id,
      providerVersionId: provider.currentVersionId,
      externalAccountId: input.externalAccountId?.trim().slice(0, 100) || null,
      pollIntervalSeconds: poll,
      lastError: null,
      metadata: j({ environment }),
    };
    const existing = await this.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', propertyId).where('channel', '=', channel).executeTakeFirst();
    const webhookKey = def.capabilities.webhooks ? existing?.webhookKey ?? randomBytes(32).toString('base64url') : null;
    const conn = existing
      ? await this.db.updateTable('channelConnections').set({ ...base, webhookKey }).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow()
      : await this.db.insertInto('channelConnections').values({ propertyId, channel, ...base, webhookKey }).returningAll().executeTakeFirstOrThrow();

    await this.secrets.set(conn.id, this.toSecrets(credentials));
    await this.audit.log({ user, meta }, { action: 'channel.connect_start', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel, environment } });

    const adapter = await this.registry.forConnection(conn);
    try {
      await adapter.connect({ propertyId, connectionId: conn.id, state: '', redirectUri: '' });
    } catch (err) {
      const message = this.safe(err);
      await this.db.updateTable('channelConnections').set({ status: ChannelConnectionStatus.ERROR, lastError: message }).where('id', '=', conn.id).execute();
      await this.audit.log({ user, meta }, { action: 'channel.connect_failed', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel, reason: message } });
      throw err instanceof ChannelError ? new ChannelError(err.code, message, false, err.details) : err;
    }
    await this.db.updateTable('channelConnections').set({ status: ChannelConnectionStatus.CONNECTED, connectedAt: new Date(), lastError: null, oauthStateHash: null, oauthStateExpiresAt: null }).where('id', '=', conn.id).execute();
    await this.audit.log({ user, meta }, { action: 'channel.connected', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel, providerVersion: provider.currentVersionId } });
    await this.channels.afterConnected(propertyId, adapter);
    return this.describe(propertyId, channel);
  }

  /** Replaces credentials. The new ones are verified first; if they do not work the old ones are put back. */
  async rotate(user: AuthUser, meta: RequestMeta, propertyId: string, channel: string, credentials: CredentialInput, feeds?: { name: string; url: string }[]) {
    const conn = await this.requireConnection(propertyId, channel);
    const row = await this.providerRow(user, channel);
    const isIcal = row.protocol === ProviderProtocol.ICAL;
    if (isIcal && !feeds?.length) throw new DomainValidationError('Send the full list of calendar feeds');
    const { def } = isIcal ? { def: undefined } : await this.loadProvider(user, channel);
    const previous = await this.secrets.load(conn.id);
    await this.secrets.set(conn.id, isIcal ? { [ConnectionSecretKind.FEED_URLS]: JSON.stringify(this.normalizeFeeds(feeds!)) } : this.toSecrets(credentials));
    const adapter = await this.registry.forConnection(conn);
    const test = await (adapter as GenericRestAdapter | IcalAdapter).testConnection();
    if (!test.ok) {
      await this.secrets.set(conn.id, previous as Partial<Record<ConnectionSecretKind, string>>);
      await this.audit.log({ user, meta }, { action: 'channel.credentials_rotate_failed', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel, reason: test.message } });
      throw new ChannelError('CHANNEL_CONNECTION_TEST_FAILED', `The new credentials were not accepted (${test.message}); the previous ones are still in place`, false);
    }
    await this.db.updateTable('channelConnections').set({ status: ChannelConnectionStatus.CONNECTED, lastError: null }).where('id', '=', conn.id).execute();
    await this.audit.log({ user, meta }, { action: 'channel.credentials_rotate', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel, kinds: Object.keys(credentials).filter((k) => (credentials as Record<string, unknown>)[k]) } });
    void def;
    return this.describe(propertyId, channel);
  }

  async updateSettings(user: AuthUser, meta: RequestMeta, propertyId: string, channel: string, input: { pollIntervalSeconds?: number | null; environment?: 'production' | 'sandbox' }) {
    const conn = await this.requireConnection(propertyId, channel);
    const row = await this.providerRow(user, channel);
    const def = row.protocol === ProviderProtocol.ICAL ? undefined : (await this.loadProvider(user, channel)).def;
    const set: Record<string, unknown> = {};
    if (input.pollIntervalSeconds !== undefined) set.pollIntervalSeconds = this.pollSetting(def, input.pollIntervalSeconds);
    if (input.environment) {
      if (!def || (input.environment === 'sandbox' && !def.environments.sandbox)) throw new DomainValidationError('This provider has no sandbox environment');
      set.metadata = j({ ...(conn.metadata ?? {}), environment: input.environment });
      set.status = ChannelConnectionStatus.CONNECTING; // a different environment must be verified again before it is trusted
    }
    if (Object.keys(set).length) await this.db.updateTable('channelConnections').set(set).where('id', '=', conn.id).execute();
    await this.audit.log({ user, meta }, { action: 'channel.settings_update', entityType: 'ChannelConnection', entityId: conn.id, propertyId, after: { ...input } });
    return this.describe(propertyId, channel);
  }

  /** A read-only health call with the stored credentials. Updates the connection's health, never its data. */
  async test(user: AuthUser, meta: RequestMeta, propertyId: string, channel: string) {
    const conn = await this.requireConnection(propertyId, channel);
    const adapter = (await this.registry.forConnection(conn)) as GenericRestAdapter | IcalAdapter;
    const result = (await adapter.testConnection()) as { ok: boolean; message: string; status?: number };
    const set: Record<string, unknown> = { lastError: result.ok ? null : result.message };
    if (result.ok && conn.status === ChannelConnectionStatus.CONNECTING) set.status = ChannelConnectionStatus.CONNECTED;
    if (!result.ok && result.status === 401) set.status = ChannelConnectionStatus.ERROR;
    await this.db.updateTable('channelConnections').set(set).where('id', '=', conn.id).execute();
    await this.audit.log({ user, meta }, { action: 'channel.test', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel, ok: result.ok } });
    return result;
  }

  /** Everything the connection screen shows. No secret value, no definition internals. */
  async describe(propertyId: string, channel: string) {
    const conn = await this.requireConnection(propertyId, channel);
    const provider = conn.providerId ? await this.db.selectFrom('channelProviders').select(['code', 'name', 'protocol']).where('id', '=', conn.providerId).executeTakeFirst() : null;
    const feeds = provider?.protocol === ProviderProtocol.ICAL ? this.feedSummaries(await this.secrets.load(conn.id)) : undefined;
    const version = conn.providerVersionId ? await this.db.selectFrom('channelProviderVersions').select(['version', 'definition']).where('id', '=', conn.providerVersionId).executeTakeFirst() : null;
    const def = version?.definition as unknown as ProviderDefinition | undefined;
    return {
      channel,
      provider: provider ? { code: provider.code, name: provider.name, version: version?.version ?? null } : null,
      status: conn.status,
      environment: (conn.metadata as { environment?: string } | null)?.environment ?? 'production',
      externalAccountId: conn.externalAccountId,
      connectedAt: conn.connectedAt,
      lastSyncAt: conn.lastSyncAt,
      lastError: conn.lastError,
      capabilities: def ? Object.entries(def.capabilities).filter(([, on]) => on).map(([k]) => k) : provider?.protocol === ProviderProtocol.ICAL ? ['listings', 'pullReservations', 'polling'] : [],
      feeds,
      credentials: (await this.secrets.describe(conn.id)).map((s) => ({ kind: s.kind, storedAt: s.createdAt, rotatedAt: s.rotatedAt })),
      polling: { intervalSeconds: conn.pollIntervalSeconds, lastPollAt: conn.lastPollAt, lastPollError: conn.lastPollError, cursor: (conn.pollCursor as { updatedSince?: string } | null)?.updatedSince ?? null },
      webhook: def?.webhook ? { url: this.webhookUrl(conn.webhookKey), signatureHeader: def.webhook.signature.header } : null,
    };
  }

  // ------------------------------------------------------------ helpers

  private async requireConnection(propertyId: string, channel: string): Promise<ChannelConnection> {
    const conn = await this.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', propertyId).where('channel', '=', channel).executeTakeFirst();
    if (!conn || !conn.providerId) throw new NotFoundError('Channel connection', channel);
    return conn;
  }

  /** The provider row: it must exist, be active and be visible to the caller's organization. */
  private async providerRow(user: AuthUser, channel: string) {
    if (!this.registry.providersEnabled) throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', 'Configured providers are not enabled on this deployment', false);
    const provider = await this.db.selectFrom('channelProviders').selectAll().where('code', '=', channel).where('status', '=', ProviderStatus.ACTIVE).where('protocol', 'in', [ProviderProtocol.REST_JSON, ProviderProtocol.ICAL]).executeTakeFirst();
    const visible = provider && (provider.visibility === ProviderVisibility.PLATFORM || (!!user.organizationId && provider.ownerOrganizationId === user.organizationId));
    if (!provider || !visible) throw new NotFoundError('Provider', channel);
    return provider;
  }

  /** Calendar feeds: connected only once every feed has been fetched and parsed as a calendar. */
  private async connectIcal(user: AuthUser, meta: RequestMeta, propertyId: string, provider: { id: string; code: string; name: string }, input: ConnectInput) {
    const feeds = this.normalizeFeeds(input.feeds ?? []);
    const poll = this.pollSetting(undefined, input.pollIntervalSeconds);
    const base = { status: ChannelConnectionStatus.CONNECTING, providerId: provider.id, providerVersionId: null, pollIntervalSeconds: poll, lastError: null, externalAccountId: null, metadata: j({ environment: 'production' }) };
    const existing = await this.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', propertyId).where('channel', '=', provider.code).executeTakeFirst();
    const conn = existing
      ? await this.db.updateTable('channelConnections').set(base).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow()
      : await this.db.insertInto('channelConnections').values({ propertyId, channel: provider.code, ...base }).returningAll().executeTakeFirstOrThrow();
    await this.secrets.set(conn.id, { [ConnectionSecretKind.FEED_URLS]: JSON.stringify(feeds) });
    await this.audit.log({ user, meta }, { action: 'channel.connect_start', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel: provider.code, feeds: feeds.length } });
    const adapter = await this.registry.forConnection(conn);
    try {
      await adapter.connect({ propertyId, connectionId: conn.id, state: '', redirectUri: '' });
    } catch (err) {
      const message = this.safe(err);
      await this.db.updateTable('channelConnections').set({ status: ChannelConnectionStatus.ERROR, lastError: message }).where('id', '=', conn.id).execute();
      throw err instanceof ChannelError ? new ChannelError(err.code, message, false, err.details) : err;
    }
    await this.db.updateTable('channelConnections').set({ status: ChannelConnectionStatus.CONNECTED, connectedAt: new Date(), lastError: null }).where('id', '=', conn.id).execute();
    await this.audit.log({ user, meta }, { action: 'channel.connected', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel: provider.code } });
    await this.channels.afterConnected(propertyId, adapter);
    return this.describe(propertyId, provider.code);
  }

  private normalizeFeeds(input: { name: string; url: string }[]): IcalFeed[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 10) throw new DomainValidationError('Add between 1 and 10 calendar feeds');
    const allowPrivate = this.config.get('channelProviders', { infer: true }).allowPrivateTargets;
    const out = new Map<string, IcalFeed>();
    for (const f of input) {
      const name = String(f?.name ?? '').trim();
      const raw = String(f?.url ?? '').trim();
      if (!name || name.length > 100) throw new DomainValidationError('Every calendar feed needs a name of up to 100 characters');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new DomainValidationError(`"${name}": the address is not a valid URL`);
      }
      if (raw.length > 1000) throw new DomainValidationError(`"${name}": the address is too long`);
      if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new DomainValidationError(`"${name}": the address must start with https://`);
      if (url.username || url.password) throw new DomainValidationError(`"${name}": the address must not contain a user name or password`);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!allowPrivate && (isIP(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.'))) throw new DomainValidationError(`"${name}": the address must be a public web address`);
      const id = feedIdFor(raw);
      out.set(id, { id, name, url: raw });
    }
    return [...out.values()];
  }

  /** Feed names and hosts for the screen; the full address is a secret and is never returned. */
  private feedSummaries(secrets: { FEED_URLS?: string }): { id: string; name: string; host: string }[] {
    try {
      return (JSON.parse(secrets.FEED_URLS ?? '[]') as IcalFeed[]).map((f) => ({ id: f.id, name: f.name, host: new URL(f.url).hostname }));
    } catch {
      return [];
    }
  }

  /** The provider must exist, be active, have a published version and be visible to the caller's organization. */
  private async loadProvider(user: AuthUser, channel: string) {
    if (!this.registry.providersEnabled) throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', 'Configured providers are not enabled on this deployment', false);
    const provider = await this.db.selectFrom('channelProviders').selectAll().where('code', '=', channel).where('protocol', '=', ProviderProtocol.REST_JSON).where('status', '=', ProviderStatus.ACTIVE).executeTakeFirst();
    const visible = provider && (provider.visibility === ProviderVisibility.PLATFORM || (!!user.organizationId && provider.ownerOrganizationId === user.organizationId));
    if (!provider || !visible || !provider.currentVersionId) throw new NotFoundError('Provider', channel);
    const v = await this.db.selectFrom('channelProviderVersions').select('definition').where('id', '=', provider.currentVersionId).executeTakeFirstOrThrow();
    const checked = validateDefinition(v.definition, { allowInsecureHosts: this.config.get('channelProviders', { infer: true }).allowPrivateTargets });
    if (!checked.ok || !checked.definition) throw new ChannelError('CHANNEL_INTEGRATION_NOT_AVAILABLE', `${provider.name} has an invalid definition`, false);
    return { provider, def: checked.definition };
  }

  private requireCredentials(def: ProviderDefinition, c: CredentialInput) {
    const need = [...(SECRET_KINDS_FOR_AUTH[def.auth.type] ?? []), ...(def.signing ? [ConnectionSecretKind.SIGNING_SECRET] : [])];
    const missing = need.filter((k) => !(c as Record<string, string | undefined>)[k]);
    if (missing.length) throw new DomainValidationError(`Missing credentials: ${missing.join(', ')}`, { missing });
    if (def.webhook && !c.WEBHOOK_SECRET) {
      // Allowed: the connection then works without webhooks (polling only); the owner can add the secret later.
    }
  }

  private toSecrets(c: CredentialInput): Partial<Record<ConnectionSecretKind, string>> {
    const out: Partial<Record<ConnectionSecretKind, string>> = {};
    for (const k of Object.values(ConnectionSecretKind)) {
      const v = (c as Record<string, string | undefined>)[k];
      if (typeof v === 'string' && v.length) out[k] = v;
    }
    return out;
  }

  private pollSetting(def: ProviderDefinition | undefined, requested: number | null | undefined): number | null {
    if (def && !def.capabilities.polling) {
      if (requested) throw new DomainValidationError('This provider does not support polling');
      return null;
    }
    const v = requested === undefined ? def?.defaultPollIntervalSeconds ?? 900 : requested;
    if (v === null) return null; // polling switched off by the owner (webhooks only)
    if (!Number.isInteger(v) || v < MIN_POLL_SECONDS || v > 86_400) throw new DomainValidationError(`The polling interval must be between ${MIN_POLL_SECONDS} and 86400 seconds`);
    return v;
  }

  private safe(err: unknown): string {
    return redactText(err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
}
