import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser, RequestMeta } from '../../../common/auth/auth-user';
import type { AppConfig } from '../../../config/configuration';
import type { ChannelProvider, ChannelProviderVersion } from '../../../database/db-types';
import { ProviderKind, ProviderProtocol, ProviderStatus, ProviderTestEnvironment, ProviderVersionStatus, ProviderVisibility, UserRole, ChannelCode } from '../../../database/enums';
import { ConflictError, DomainValidationError, ForbiddenError, NotFoundError } from '../../../database/errors';
import { Db, InjectDb, j, runInTransaction } from '../../../database/kysely';
import { AuditLogger } from '../../audit/audit.logger';
import { SECRET_KINDS_FOR_AUTH } from './connection-secrets.service';
import { GenericRestAdapter, type ProviderSecrets } from './generic-rest.adapter';
import { MAX_DEFINITION_BYTES, type ProviderDefinition, validateDefinition, type ValidationResult } from './provider-definition';

const CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const RESERVED = new Set<string>([...Object.values(ChannelCode), 'RAZORPAY', 'API', 'WALK_IN', 'PHONE', 'AGENT']);

export const stableStringify = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
};
export const definitionHash = (def: unknown) => createHash('sha256').update(stableStringify(def)).digest('hex');

export interface DryRunStep {
  step: string;
  ok: boolean;
  detail: string;
}

/** What a partner sees in the provider catalogue: capabilities and requirements, never the definition's internals. */
export interface ProviderCatalogueEntry {
  id: string;
  code: string;
  name: string;
  kind: string;
  protocol: string;
  builtIn: boolean;
  /** false = a code adapter that is not operational in this deployment (partner approval pending), or a provider without a published version */
  operational: boolean;
  capabilities: string[];
  authType: string | null;
  requiredCredentials: string[];
  supportsWebhooks: boolean;
  supportsPolling: boolean;
  sandboxAvailable: boolean;
  defaultPollIntervalSeconds: number | null;
  versionId: string | null;
  version: number | null;
}

const isPlatformAdmin = (u: AuthUser) => u.role === UserRole.SUPER_ADMIN || u.role === UserRole.OPERATIONS_ADMIN;

/**
 * Provider definitions: draft, validate, dry-run, publish, roll back. Only platform administrators change what is globally
 * available; a published version is immutable (also enforced by a database trigger), so connections that pin it never change
 * underneath their owners. Rolling back publishes a COPY of an older version as a new version, so history is never rewritten.
 */
@Injectable()
export class ProviderService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get allowPrivate(): boolean {
    return this.config.get('channelProviders', { infer: true }).allowPrivateTargets;
  }

  validate(def: unknown): ValidationResult {
    return validateDefinition(def, { allowInsecureHosts: this.allowPrivate });
  }

  // ------------------------------------------------------------ reads

  async list(user: AuthUser): Promise<ChannelProvider[]> {
    let q = this.db.selectFrom('channelProviders').selectAll().orderBy('code');
    if (!isPlatformAdmin(user)) {
      q = q.where('status', '=', ProviderStatus.ACTIVE).where((w) => w.or([w('visibility', '=', ProviderVisibility.PLATFORM), w('ownerOrganizationId', '=', user.organizationId ?? '00000000-0000-0000-0000-000000000000')]));
    }
    return q.execute();
  }

  async get(user: AuthUser, id: string): Promise<{ provider: ChannelProvider; versions: Omit<ChannelProviderVersion, 'definition'>[] }> {
    const provider = await this.db.selectFrom('channelProviders').selectAll().where('id', '=', id).executeTakeFirst();
    if (!provider || !this.canSee(user, provider)) throw new NotFoundError('Provider', id);
    const versions = await this.db
      .selectFrom('channelProviderVersions')
      .select(['id', 'providerId', 'version', 'status', 'definitionHash', 'validation', 'notes', 'createdBy', 'publishedBy', 'publishedAt', 'createdAt'])
      .where('providerId', '=', id)
      .orderBy('version', 'desc')
      .execute();
    return { provider, versions: versions as never };
  }

  async getVersion(user: AuthUser, versionId: string): Promise<{ provider: ChannelProvider; version: ChannelProviderVersion }> {
    const version = await this.db.selectFrom('channelProviderVersions').selectAll().where('id', '=', versionId).executeTakeFirst();
    if (!version) throw new NotFoundError('Provider version', versionId);
    const provider = await this.db.selectFrom('channelProviders').selectAll().where('id', '=', version.providerId).executeTakeFirstOrThrow();
    // Definitions are readable only by platform admins (they may contain operational detail); partners get the catalogue entry.
    if (!isPlatformAdmin(user)) throw new NotFoundError('Provider version', versionId);
    return { provider, version };
  }

  /** The partner-facing catalogue: every provider that can be connected, with what it can do and what it needs. */
  async catalogue(user: AuthUser): Promise<ProviderCatalogueEntry[]> {
    const providers = (await this.list(user)).filter((p) => p.protocol !== ProviderProtocol.INTERNAL && p.code !== 'RAZORPAY' && (isPlatformAdmin(user) || p.code !== ChannelCode.OTHER));
    const versionIds = providers.map((p) => p.currentVersionId).filter((x): x is string => !!x);
    const versions = versionIds.length ? await this.db.selectFrom('channelProviderVersions').select(['id', 'version', 'definition']).where('id', 'in', versionIds).execute() : [];
    const byId = new Map(versions.map((v) => [v.id, v]));
    return providers
      .filter((p) => p.code !== ChannelCode.MOCK || this.config.get('mockChannel', { infer: true }).enabled)
      .map((p) => {
        const v = p.currentVersionId ? byId.get(p.currentVersionId) : undefined;
        const def = v?.definition as unknown as ProviderDefinition | undefined;
        const caps = def ? Object.entries(def.capabilities).filter(([, on]) => on).map(([k]) => k) : [];
        const secretKinds = def ? SECRET_KINDS_FOR_AUTH[def.auth.type] ?? [] : [];
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          kind: p.kind,
          protocol: p.protocol,
          builtIn: p.builtIn,
          operational: p.protocol === ProviderProtocol.REST_JSON ? !!def : p.protocol === ProviderProtocol.ICAL,
          capabilities: p.protocol === ProviderProtocol.ICAL ? ['listings', 'pullReservations', 'polling'] : caps,
          authType: p.protocol === ProviderProtocol.ICAL ? 'FEED_URL' : def?.auth.type ?? null,
          requiredCredentials: p.protocol === ProviderProtocol.ICAL ? ['FEED_URLS'] : [...secretKinds, ...(def?.signing ? ['SIGNING_SECRET'] : []), ...(def?.webhook ? ['WEBHOOK_SECRET'] : [])],
          supportsWebhooks: !!def?.capabilities.webhooks,
          supportsPolling: p.protocol === ProviderProtocol.ICAL ? true : !!def?.capabilities.polling,
          sandboxAvailable: !!def?.environments.sandbox,
          defaultPollIntervalSeconds: p.protocol === ProviderProtocol.ICAL ? 900 : def?.defaultPollIntervalSeconds ?? null,
          versionId: v?.id ?? null,
          version: v?.version ?? null,
        };
      });
  }

  // ------------------------------------------------------------ authoring (platform administrators)

  async create(user: AuthUser, meta: RequestMeta, input: { code: string; name: string; kind: ProviderKind }): Promise<ChannelProvider> {
    this.requireAdmin(user);
    if (!CODE.test(input.code)) throw new DomainValidationError('Provider code must be 2-32 characters: capital letters, digits and underscores, starting with a letter');
    if (RESERVED.has(input.code)) throw new ConflictError('PROVIDER_CODE_RESERVED', `The code ${input.code} is reserved`);
    if (input.kind === ProviderKind.TEST || input.kind === ProviderKind.PAYMENT) throw new DomainValidationError('That provider kind cannot be created here');
    const exists = await this.db.selectFrom('channelProviders').select('id').where('code', '=', input.code).executeTakeFirst();
    if (exists) throw new ConflictError('PROVIDER_EXISTS', `A provider with code ${input.code} already exists`);
    const row = await this.db
      .insertInto('channelProviders')
      .values({ code: input.code, name: input.name.trim(), kind: input.kind, protocol: ProviderProtocol.REST_JSON, status: ProviderStatus.DRAFT, visibility: ProviderVisibility.PLATFORM, createdBy: user.userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'provider.create', entityType: 'ChannelProvider', entityId: row.id, after: { code: row.code, name: row.name } });
    return row;
  }

  async createVersion(user: AuthUser, meta: RequestMeta, providerId: string, definition: unknown, notes?: string): Promise<{ version: ChannelProviderVersion; validation: ValidationResult }> {
    this.requireAdmin(user);
    const provider = await this.db.selectFrom('channelProviders').selectAll().where('id', '=', providerId).executeTakeFirst();
    if (!provider) throw new NotFoundError('Provider', providerId);
    if (provider.builtIn) throw new ForbiddenError('Built-in providers are implemented in code and have no definition', 'PROVIDER_BUILT_IN');
    const validation = this.checkedStore(definition);
    const next = await this.db.selectFrom('channelProviderVersions').select((eb) => eb.fn.max('version').as('v')).where('providerId', '=', providerId).executeTakeFirst();
    const version = await this.db
      .insertInto('channelProviderVersions')
      .values({
        providerId,
        version: (next?.v ?? 0) + 1,
        status: validation.ok ? ProviderVersionStatus.VALIDATED : ProviderVersionStatus.DRAFT,
        definition: j(definition as Record<string, unknown>),
        definitionHash: definitionHash(definition),
        validation: j({ ok: validation.ok, errors: validation.errors, warnings: validation.warnings }),
        notes: notes?.slice(0, 1000) ?? null,
        createdBy: user.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'provider.version_create', entityType: 'ChannelProviderVersion', entityId: version.id, after: { providerId, version: version.version, valid: validation.ok } });
    return { version, validation };
  }

  /** Replaces the definition of a version that has not been published. */
  async updateDraft(user: AuthUser, meta: RequestMeta, versionId: string, definition: unknown): Promise<{ version: ChannelProviderVersion; validation: ValidationResult }> {
    this.requireAdmin(user);
    const existing = await this.db.selectFrom('channelProviderVersions').selectAll().where('id', '=', versionId).executeTakeFirst();
    if (!existing) throw new NotFoundError('Provider version', versionId);
    if (existing.status === ProviderVersionStatus.PUBLISHED || existing.status === ProviderVersionStatus.RETIRED) {
      throw new ConflictError('VERSION_IMMUTABLE', 'A published version is immutable; create a new version instead');
    }
    const validation = this.checkedStore(definition);
    const version = await this.db
      .updateTable('channelProviderVersions')
      .set({
        definition: j(definition as Record<string, unknown>),
        definitionHash: definitionHash(definition),
        status: validation.ok ? ProviderVersionStatus.VALIDATED : ProviderVersionStatus.DRAFT,
        validation: j({ ok: validation.ok, errors: validation.errors, warnings: validation.warnings }),
      })
      .where('id', '=', versionId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'provider.version_update', entityType: 'ChannelProviderVersion', entityId: versionId, after: { valid: validation.ok } });
    return { version, validation };
  }

  async diff(user: AuthUser, aId: string, bId: string): Promise<{ path: string; from: unknown; to: unknown }[]> {
    const [a, b] = await Promise.all([this.getVersion(user, aId), this.getVersion(user, bId)]);
    if (a.provider.id !== b.provider.id) throw new DomainValidationError('Versions belong to different providers');
    return diffJson(a.version.definition, b.version.definition);
  }

  /**
   * Read-only checks against the provider's sandbox (or the configured environment), with credentials supplied for this call only.
   * Never pushes anything and never creates a booking. The outcome (no secrets, no guest data) is stored as a test result.
   */
  async dryRun(user: AuthUser, meta: RequestMeta, versionId: string, input: { environment: 'production' | 'sandbox'; secrets: ProviderSecrets }): Promise<{ passed: boolean; steps: DryRunStep[] }> {
    this.requireAdmin(user);
    const { provider, version } = await this.getVersion(user, versionId);
    const checked = this.validate(version.definition);
    if (!checked.ok) throw new DomainValidationError('The definition is not valid; fix the validation errors before testing', { errors: checked.errors });
    const def = checked.definition!;
    const steps: DryRunStep[] = [];
    const adapter = new GenericRestAdapter(def, {
      providerCode: provider.code,
      displayName: provider.name,
      environment: input.environment,
      connectionId: randomUUID(),
      secrets: input.secrets,
      allowPrivate: this.allowPrivate,
    });
    const run = async (step: string, fn: () => Promise<string>) => {
      try {
        steps.push({ step, ok: true, detail: await fn() });
      } catch (e) {
        steps.push({ step, ok: false, detail: String((e as Error).message).slice(0, 300) });
      }
    };
    const creds = { metadata: {} };
    await run('healthCheck', async () => {
      const t = await adapter.testConnection();
      if (!t.ok) throw new Error(t.message);
      return `reachable in ${t.latencyMs} ms`;
    });
    if (steps[0].ok) {
      let firstListing: string | undefined;
      if (adapter.supports('listings')) {
        await run('listListings', async () => {
          const l = await adapter.getListings(creds);
          firstListing = l[0]?.externalListingId;
          return `${l.length} listing(s)`;
        });
      }
      if (firstListing && adapter.supports('roomTypes')) await run('listRoomTypes', async () => `${(await adapter.getRoomTypes(creds, firstListing!)).length} room type(s)`);
      if (firstListing && adapter.supports('ratePlans')) await run('listRatePlans', async () => `${(await adapter.getRates(creds, firstListing!)).length} rate plan(s)`);
      if (adapter.supports('pullReservations')) {
        await run('listReservations', async () => {
          const r = await adapter.pullReservations(new Date(Date.now() - 86_400_000));
          return `${r.events.length} mappable reservation(s), ${r.skipped.length} skipped`;
        });
      }
    }
    const passed = steps.length > 0 && steps.every((s) => s.ok);
    await this.db
      .insertInto('channelProviderTests')
      .values({ providerId: provider.id, versionId, environment: input.environment === 'sandbox' ? ProviderTestEnvironment.SANDBOX : ProviderTestEnvironment.PRODUCTION, passed, results: j(steps as unknown as Record<string, unknown>[]), runBy: user.userId })
      .execute();
    await this.audit.log({ user, meta }, { action: 'provider.dry_run', entityType: 'ChannelProviderVersion', entityId: versionId, after: { passed, environment: input.environment } });
    return { passed, steps };
  }

  async publish(user: AuthUser, meta: RequestMeta, versionId: string): Promise<{ provider: ChannelProvider; version: ChannelProviderVersion }> {
    this.requireAdmin(user);
    if (user.role !== UserRole.SUPER_ADMIN) throw new ForbiddenError('Only a super admin can publish a provider version', 'FORBIDDEN');
    const { provider, version } = await this.getVersion(user, versionId);
    if (provider.builtIn) throw new ForbiddenError('Built-in providers have no definition', 'PROVIDER_BUILT_IN');
    if (version.status === ProviderVersionStatus.PUBLISHED && provider.currentVersionId === version.id) return { provider, version };
    if (version.status !== ProviderVersionStatus.VALIDATED) throw new ConflictError('VERSION_NOT_VALIDATED', 'Only a validated version can be published');
    const again = this.validate(version.definition); // re-checked at the moment of publication, not trusted from storage
    if (!again.ok) throw new DomainValidationError('The definition is no longer valid', { errors: again.errors });
    const out = await runInTransaction(this.db, async (tx) => {
      if (provider.currentVersionId) {
        await tx.updateTable('channelProviderVersions').set({ status: ProviderVersionStatus.RETIRED }).where('id', '=', provider.currentVersionId).execute();
      }
      const published = await tx.updateTable('channelProviderVersions').set({ status: ProviderVersionStatus.PUBLISHED, publishedBy: user.userId, publishedAt: new Date() }).where('id', '=', versionId).returningAll().executeTakeFirstOrThrow();
      const prov = await tx.updateTable('channelProviders').set({ currentVersionId: versionId, status: ProviderStatus.ACTIVE, updatedAt: new Date() }).where('id', '=', provider.id).returningAll().executeTakeFirstOrThrow();
      return { provider: prov, version: published };
    });
    await this.audit.log({ user, meta }, { action: 'provider.publish', entityType: 'ChannelProvider', entityId: provider.id, after: { version: version.version, hash: version.definitionHash } });
    return out;
  }

  /** Publishes a copy of an earlier version as the newest one. */
  async rollback(user: AuthUser, meta: RequestMeta, providerId: string, toVersionId: string): Promise<{ provider: ChannelProvider; version: ChannelProviderVersion }> {
    this.requireAdmin(user);
    const { provider, version } = await this.getVersion(user, toVersionId);
    if (provider.id !== providerId) throw new DomainValidationError('That version belongs to a different provider');
    const created = await this.createVersion(user, meta, providerId, version.definition, `Rollback to version ${version.version}`);
    if (!created.validation.ok) throw new DomainValidationError('The earlier version no longer passes validation', { errors: created.validation.errors });
    const out = await this.publish(user, meta, created.version.id);
    await this.audit.log({ user, meta }, { action: 'provider.rollback', entityType: 'ChannelProvider', entityId: providerId, after: { restoredFrom: version.version, newVersion: created.version.version } });
    return out;
  }

  async setStatus(user: AuthUser, meta: RequestMeta, providerId: string, status: ProviderStatus.ACTIVE | ProviderStatus.DISABLED): Promise<ChannelProvider> {
    this.requireAdmin(user);
    const p = await this.db.selectFrom('channelProviders').selectAll().where('id', '=', providerId).executeTakeFirst();
    if (!p) throw new NotFoundError('Provider', providerId);
    if (p.builtIn) throw new ForbiddenError('Built-in providers cannot be switched here', 'PROVIDER_BUILT_IN');
    if (status === ProviderStatus.ACTIVE && !p.currentVersionId) throw new ConflictError('NO_PUBLISHED_VERSION', 'Publish a version first');
    const row = await this.db.updateTable('channelProviders').set({ status, updatedAt: new Date() }).where('id', '=', providerId).returningAll().executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: status === ProviderStatus.DISABLED ? 'provider.disable' : 'provider.enable', entityType: 'ChannelProvider', entityId: providerId });
    return row;
  }

  // ------------------------------------------------------------ helpers

  private requireAdmin(user: AuthUser) {
    if (!isPlatformAdmin(user)) throw new ForbiddenError('Only platform administrators manage providers', 'FORBIDDEN');
  }

  private canSee(user: AuthUser, p: ChannelProvider): boolean {
    if (isPlatformAdmin(user)) return true;
    if (p.status !== ProviderStatus.ACTIVE) return false;
    return p.visibility === ProviderVisibility.PLATFORM || (!!user.organizationId && p.ownerOrganizationId === user.organizationId);
  }

  private checkedStore(definition: unknown): ValidationResult {
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) throw new DomainValidationError('The definition must be a JSON object');
    if (Buffer.byteLength(JSON.stringify(definition)) > MAX_DEFINITION_BYTES) throw new DomainValidationError(`The definition is larger than ${MAX_DEFINITION_BYTES} bytes`);
    return this.validate(definition);
  }
}

function diffJson(a: unknown, b: unknown, path = '$', out: { path: string; from: unknown; to: unknown }[] = []): { path: string; from: unknown; to: unknown }[] {
  if (out.length > 500) return out;
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffJson(a[k], b[k], `${path}.${k}`, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, from: a, to: b });
  return out;
}
