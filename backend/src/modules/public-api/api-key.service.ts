import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Connection, Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { API_SCOPES, ApiKeyStatus } from '../../database/enums';
import { DomainValidationError, NotFoundError, UnauthorizedError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import { AuditLogger } from '../audit/audit.logger';

/** What an authenticated API request carries. Everything an endpoint needs for tenant isolation. */
export interface ApiPrincipal {
  apiKeyId: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** Empty = all properties of the organization. */
  propertyIds: Types.ObjectId[];
  scopes: string[];
}

const KEY_RE = /^tvk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** lastUsedAt is written at most this often per key, so a busy client does not turn every read into a write. */
const TOUCH_INTERVAL_MS = 60_000;

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const prefix = Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
  const key = `tvk_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, keyHash: sha256Hex(key) };
}

@Injectable()
export class ApiKeyService {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  /** Resolves a presented key to its principal, or throws 401. Never reveals which check failed. */
  async authenticate(raw: string): Promise<ApiPrincipal> {
    const bad = () => new UnauthorizedError('Invalid API key', 'API_KEY_INVALID');
    const match = KEY_RE.exec(raw);
    if (!match) throw bad();
    const doc = await this.m.ApiKey.findOne({ prefix: match[1] }).select('+keyHash').lean();
    if (!doc) throw bad();
    const presented = Buffer.from(sha256Hex(raw), 'hex');
    const stored = Buffer.from(doc.keyHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) throw bad();
    if (doc.status !== ApiKeyStatus.ACTIVE) throw new UnauthorizedError('API key has been revoked', 'API_KEY_REVOKED');
    if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError('API key has expired', 'API_KEY_EXPIRED');

    if (!doc.lastUsedAt || Date.now() - doc.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      void this.m.ApiKey.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return { apiKeyId: doc._id, organizationId: doc.organizationId, propertyIds: doc.propertyIds, scopes: doc.scopes };
  }

  // ------------------------------------------------------------ management (signed-in organization owners)

  async create(user: AuthUser, meta: RequestMeta, input: { name: string; scopes: string[]; propertyIds?: string[]; expiresAt?: Date }) {
    const organizationId = this.orgOf(user);
    const unknown = input.scopes.filter((s) => !(API_SCOPES as readonly string[]).includes(s));
    if (unknown.length) throw new DomainValidationError(`Unknown scope(s): ${unknown.join(', ')}`, { allowed: [...API_SCOPES] });
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new DomainValidationError('expiresAt must be in the future');
    const propertyIds = await this.ownedProperties(organizationId, input.propertyIds);

    const { key, prefix, keyHash } = generateApiKey();
    const doc = await this.m.ApiKey.create({
      organizationId,
      propertyIds,
      name: input.name,
      prefix,
      keyHash,
      scopes: [...new Set(input.scopes)],
      expiresAt: input.expiresAt ?? null,
      createdBy: user.userId,
    });
    await this.audit.log({ user, meta }, { action: 'api_key.create', entityType: 'ApiKey', entityId: doc._id, after: { name: input.name, prefix, scopes: input.scopes } });
    // The only moment the secret exists in clear text.
    return { ...this.view(doc.toObject()), key };
  }

  async list(user: AuthUser) {
    const rows = await this.m.ApiKey.find({ organizationId: this.orgOf(user) }).sort({ createdAt: -1 }).lean();
    return rows.map((r) => this.view(r));
  }

  async revoke(user: AuthUser, meta: RequestMeta, id: Types.ObjectId) {
    const doc = await this.m.ApiKey.findOneAndUpdate(
      { _id: id, organizationId: this.orgOf(user) },
      { $set: { status: ApiKeyStatus.REVOKED, revokedAt: new Date() } },
      { new: true },
    ).lean();
    if (!doc) throw new NotFoundError('ApiKey', id);
    await this.audit.log({ user, meta }, { action: 'api_key.revoke', entityType: 'ApiKey', entityId: doc._id, after: { prefix: doc.prefix } });
    return this.view(doc);
  }

  private orgOf(user: AuthUser): Types.ObjectId {
    if (!user.organizationId) throw new DomainValidationError('This account has no organization');
    return user.organizationId;
  }

  /** Property ids must belong to the caller's organization: a key can never be scoped to someone else's property. */
  private async ownedProperties(organizationId: Types.ObjectId, ids?: string[]): Promise<Types.ObjectId[]> {
    if (!ids?.length) return [];
    const oids = ids.map((i) => new Types.ObjectId(i));
    const found = await this.m.Property.countDocuments({ _id: { $in: oids }, organizationId });
    if (found !== new Set(ids).size) throw new DomainValidationError('propertyIds must all belong to your organization');
    return oids;
  }

  private view(d: { _id: Types.ObjectId; name: string; prefix: string; scopes: string[]; propertyIds: Types.ObjectId[]; status: string; expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date }) {
    return {
      _id: d._id,
      name: d.name,
      /** Non-secret; lets people recognise a key (tvk_abcd1234_...) in the dashboard. */
      keyPrefix: `tvk_${d.prefix}_`,
      scopes: d.scopes,
      propertyIds: d.propertyIds,
      status: d.status,
      expiresAt: d.expiresAt,
      lastUsedAt: d.lastUsedAt,
      revokedAt: d.revokedAt,
      createdAt: d.createdAt,
    };
  }
}
