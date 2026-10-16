import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import type { AppConfig } from '../../config/configuration';
import { toUuid } from '../../common/utils';
import type { ApiKey } from '../../database/db-types';
import { API_SCOPES, ApiKeyStatus, OrganizationStatus } from '../../database/enums';
import { DomainValidationError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';

/** What an authenticated API request carries. Everything an endpoint needs for tenant isolation. */
export interface ApiPrincipal {
  apiKeyId: string;
  organizationId: string;
  /** Empty = all properties of the organization. */
  propertyIds: string[];
  scopes: string[];
}

const KEY_RE = /^tvk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** last_used_at is written at most this often per key, so a busy client does not turn every read into a write. */
const TOUCH_INTERVAL_MS = 60_000;

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const prefix = Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
  const key = `tvk_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, keyHash: sha256Hex(key) };
}

type KeyView = Pick<ApiKey, 'id' | 'name' | 'prefix' | 'scopes' | 'propertyIds' | 'status' | 'expiresAt' | 'lastUsedAt' | 'lastUsedIp' | 'revokedAt' | 'createdAt' | 'environment' | 'rotatedFrom'>;

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Resolves a presented key to its principal, or throws 401. Never reveals which check failed. */
  async authenticate(raw: string, ip?: string): Promise<ApiPrincipal> {
    const bad = () => new UnauthorizedError('Invalid API key', 'API_KEY_INVALID');
    const match = KEY_RE.exec(raw);
    if (!match) throw bad();
    const doc = await this.db.selectFrom('apiKeys').selectAll().where('prefix', '=', match[1]).executeTakeFirst();
    if (!doc) throw bad();
    const presented = Buffer.from(sha256Hex(raw), 'hex');
    const stored = Buffer.from(doc.keyHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) throw bad();
    if (doc.status !== ApiKeyStatus.ACTIVE) throw new UnauthorizedError('API key has been revoked', 'API_KEY_REVOKED');
    if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError('API key has expired', 'API_KEY_EXPIRED');
    // A key is only as good as its organization: suspending or un-approving a partner stops its integrations at once.
    const org = await this.db.selectFrom('organizations').select('status').where('id', '=', doc.organizationId).executeTakeFirst();
    if (org?.status !== OrganizationStatus.ACTIVE) throw new ForbiddenError('The organization behind this API key is not active', 'ORGANIZATION_NOT_ACTIVE');

    if (!doc.lastUsedAt || Date.now() - doc.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      void this.db.updateTable('apiKeys').set({ lastUsedAt: new Date(), lastUsedIp: ip?.slice(0, 64) ?? null }).where('id', '=', doc.id).execute().catch(() => undefined);
    }
    return { apiKeyId: doc.id, organizationId: doc.organizationId, propertyIds: doc.propertyIds, scopes: doc.scopes };
  }

  // ------------------------------------------------------------ management (signed-in organization owners)

  async create(user: AuthUser, meta: RequestMeta, input: { name: string; scopes: string[]; propertyIds?: string[]; expiresAt?: Date }) {
    const organizationId = this.orgOf(user);
    const unknown = input.scopes.filter((s) => !(API_SCOPES as readonly string[]).includes(s));
    if (unknown.length) throw new DomainValidationError(`Unknown scope(s): ${unknown.join(', ')}`, { allowed: [...API_SCOPES] });
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new DomainValidationError('expiresAt must be in the future');
    const propertyIds = await this.ownedProperties(organizationId, input.propertyIds);

    const { key, prefix, keyHash } = generateApiKey();
    const doc = await this.db
      .insertInto('apiKeys')
      .values({
        organizationId,
        propertyIds,
        name: input.name.trim(),
        prefix,
        keyHash,
        scopes: [...new Set(input.scopes)],
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
        lastUsedIp: null,
        // Where this key was issued (production, staging, development): shown in the portal so keys are not mixed up.
        environment: this.config.get('env', { infer: true }),
        rotatedFrom: null,
        createdBy: user.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'api_key.create', entityType: 'ApiKey', entityId: doc.id, after: { name: doc.name, prefix, scopes: input.scopes } });
    // The only moment the secret exists in clear text.
    return { ...this.view(doc), key };
  }

  async list(user: AuthUser) {
    const rows = await this.db.selectFrom('apiKeys').selectAll().where('organizationId', '=', this.orgOf(user)).orderBy('createdAt', 'desc').execute();
    return rows.map((r) => this.view(r));
  }

  /**
   * Replaces a key with a new one that has the same name, scopes, property restriction and expiry. The new secret is returned
   * once. The old key is revoked at once, or (`graceHours` up to 72) keeps working until then so a deployment can switch over
   * without downtime: it simply expires at the end of the grace period.
   */
  async rotate(user: AuthUser, meta: RequestMeta, id: string, graceHours = 0) {
    const organizationId = this.orgOf(user);
    const old = await this.db.selectFrom('apiKeys').selectAll().where('id', '=', id).where('organizationId', '=', organizationId).where('status', '=', ApiKeyStatus.ACTIVE).executeTakeFirst();
    if (!old) throw new NotFoundError('ApiKey', id);
    const { key, prefix, keyHash } = generateApiKey();
    const now = new Date();
    const graceEnds = graceHours > 0 ? new Date(now.getTime() + graceHours * 3_600_000) : null;
    const created = await this.db
      .insertInto('apiKeys')
      .values({
        organizationId,
        propertyIds: old.propertyIds,
        name: old.name,
        prefix,
        keyHash,
        scopes: old.scopes,
        expiresAt: old.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        lastUsedIp: null,
        environment: this.config.get('env', { infer: true }),
        rotatedFrom: old.id,
        createdBy: user.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (graceEnds && (!old.expiresAt || old.expiresAt > graceEnds)) {
      await this.db.updateTable('apiKeys').set({ expiresAt: graceEnds }).where('id', '=', old.id).execute();
    } else if (!graceEnds) {
      await this.db.updateTable('apiKeys').set({ status: ApiKeyStatus.REVOKED, revokedAt: now }).where('id', '=', old.id).execute();
    }
    await this.audit.log({ user, meta }, { action: 'api_key.rotate', entityType: 'ApiKey', entityId: created.id, after: { replaces: old.id, oldPrefix: old.prefix, newPrefix: prefix, graceHours } });
    return { ...this.view(created), key };
  }

  async get(user: AuthUser, id: string) {
    const doc = await this.db.selectFrom('apiKeys').selectAll().where('id', '=', id).where('organizationId', '=', this.orgOf(user)).executeTakeFirst();
    if (!doc) throw new NotFoundError('ApiKey', id);
    return this.view(doc);
  }

  async revoke(user: AuthUser, meta: RequestMeta, id: string) {
    const doc = await this.db
      .updateTable('apiKeys')
      .set({ status: ApiKeyStatus.REVOKED, revokedAt: new Date() })
      .where('id', '=', id)
      .where('organizationId', '=', this.orgOf(user))
      .returningAll()
      .executeTakeFirst();
    if (!doc) throw new NotFoundError('ApiKey', id);
    await this.audit.log({ user, meta }, { action: 'api_key.revoke', entityType: 'ApiKey', entityId: doc.id, after: { prefix: doc.prefix } });
    return this.view(doc);
  }

  private orgOf(user: AuthUser): string {
    if (!user.organizationId) throw new DomainValidationError('This account has no organization');
    return user.organizationId;
  }

  /** Property ids must belong to the caller's organization: a key can never be scoped to someone else's property. */
  private async ownedProperties(organizationId: string, ids?: string[]): Promise<string[]> {
    if (!ids?.length) return [];
    const normalized = [...new Set(ids.map((i) => toUuid(i, 'propertyIds')))];
    const found = await this.db.selectFrom('properties').select('id').where('id', 'in', normalized).where('organizationId', '=', organizationId).execute();
    if (found.length !== normalized.length) throw new DomainValidationError('propertyIds must all belong to your organization');
    return normalized;
  }

  private view(d: KeyView) {
    return {
      id: d.id,
      name: d.name,
      /** Non-secret; lets people recognise a key (tvk_abcd1234_...) in the dashboard. */
      keyPrefix: `tvk_${d.prefix}_`,
      scopes: d.scopes,
      propertyIds: d.propertyIds,
      status: d.status,
      expiresAt: d.expiresAt,
      lastUsedAt: d.lastUsedAt,
      lastUsedIp: d.lastUsedIp,
      environment: d.environment,
      rotatedFrom: d.rotatedFrom,
      revokedAt: d.revokedAt,
      createdAt: d.createdAt,
    };
  }
}
