import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import type { AppConfig } from '../../config/configuration';
import { toUuid } from '../../common/utils';
import { encryptSecret } from '../../database/common/crypto';
import { API_EVENT_TYPES, WebhookDeliveryStatus, WebhookEndpointStatus } from '../../database/enums';
import { DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { ClientEventService } from '../../database/services/client-event.service';
import { setFrom } from '../../database/sql';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import { UnsafeWebhookTargetError, validateWebhookUrl } from './safe-http';

export interface EndpointInput {
  url?: string;
  description?: string;
  events?: string[];
  propertyIds?: string[];
  status?: WebhookEndpointStatus;
  /** Put guest e-mail/phone/special requests into the payloads (default: no). */
  includeGuestDetails?: boolean;
}

const generateSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  propertyIds: string[];
  status: string;
  includeGuestDetails: boolean;
  createdAt: Date;
}

@Injectable()
export class WebhookEndpointsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditLogger,
    private readonly outbox: OutboxDispatcher,
  ) {}

  async create(user: AuthUser, meta: RequestMeta, input: Required<Pick<EndpointInput, 'url' | 'events'>> & EndpointInput) {
    const organizationId = this.orgOf(user);
    this.checkUrl(input.url);
    const events = this.checkEvents(input.events);
    const propertyIds = await this.ownedProperties(organizationId, input.propertyIds);
    const secret = generateSecret();
    const doc = await this.db
      .insertInto('webhookEndpoints')
      .values({
        organizationId,
        propertyIds,
        url: input.url,
        description: input.description ?? null,
        events,
        secretEncrypted: encryptSecret(secret),
        includeGuestDetails: input.includeGuestDetails ?? false,
        createdBy: user.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'webhook_endpoint.create', entityType: 'WebhookEndpoint', entityId: doc.id, after: { url: input.url, events } });
    // The signing secret is returned once, here and on rotation.
    return { ...this.view(doc), secret };
  }

  async list(user: AuthUser) {
    const rows = await this.db.selectFrom('webhookEndpoints').selectAll().where('organizationId', '=', this.orgOf(user)).orderBy('createdAt', 'desc').execute();
    return rows.map((r) => this.view(r));
  }

  async update(user: AuthUser, meta: RequestMeta, id: string, input: EndpointInput) {
    const organizationId = this.orgOf(user);
    const set: Record<string, unknown> = setFrom({ description: input.description, status: input.status });
    if (input.includeGuestDetails !== undefined) set.includeGuestDetails = input.includeGuestDetails;
    if (input.url !== undefined) {
      this.checkUrl(input.url);
      set.url = input.url;
    }
    if (input.events !== undefined) set.events = this.checkEvents(input.events);
    if (input.propertyIds !== undefined) set.propertyIds = await this.ownedProperties(organizationId, input.propertyIds);
    const doc = Object.keys(set).length
      ? await this.db.updateTable('webhookEndpoints').set(set).where('id', '=', toUuid(id)).where('organizationId', '=', organizationId).returningAll().executeTakeFirst()
      : await this.db.selectFrom('webhookEndpoints').selectAll().where('id', '=', toUuid(id)).where('organizationId', '=', organizationId).executeTakeFirst();
    if (!doc) throw new NotFoundError('WebhookEndpoint', id);
    await this.audit.log({ user, meta }, { action: 'webhook_endpoint.update', entityType: 'WebhookEndpoint', entityId: doc.id, after: { ...input } });
    return this.view(doc);
  }

  async remove(user: AuthUser, meta: RequestMeta, id: string) {
    const organizationId = this.orgOf(user);
    // Deliveries go with the endpoint (ON DELETE CASCADE).
    const doc = await this.db.deleteFrom('webhookEndpoints').where('id', '=', toUuid(id)).where('organizationId', '=', organizationId).returning(['id', 'url']).executeTakeFirst();
    if (!doc) throw new NotFoundError('WebhookEndpoint', id);
    await this.audit.log({ user, meta }, { action: 'webhook_endpoint.delete', entityType: 'WebhookEndpoint', entityId: doc.id, before: { url: doc.url } });
    return { ok: true };
  }

  async rotateSecret(user: AuthUser, meta: RequestMeta, id: string) {
    const secret = generateSecret();
    const doc = await this.db
      .updateTable('webhookEndpoints')
      .set({ secretEncrypted: encryptSecret(secret) })
      .where('id', '=', toUuid(id))
      .where('organizationId', '=', this.orgOf(user))
      .returningAll()
      .executeTakeFirst();
    if (!doc) throw new NotFoundError('WebhookEndpoint', id);
    await this.audit.log({ user, meta }, { action: 'webhook_endpoint.rotate_secret', entityType: 'WebhookEndpoint', entityId: doc.id });
    return { ...this.view(doc), secret };
  }

  /** Queues a signed `ping` so integrators can verify their receiver and signature code. */
  async sendTest(user: AuthUser, id: string) {
    const endpoint = await this.mine(user, id);
    const eventId = ClientEventService.eventId('ping', endpoint.id, randomBytes(8).toString('hex'));
    const body = ClientEventService.buildBody(eventId, 'ping', { message: 'This is a test event from Tirvona.' });
    const delivery = await this.db
      .insertInto('webhookDeliveries')
      .values({ organizationId: endpoint.organizationId, endpointId: endpoint.id, eventId, eventType: 'ping', body })
      .returning('id')
      .executeTakeFirstOrThrow();
    void this.outbox.flush();
    return { deliveryId: delivery.id, eventId };
  }

  async deliveries(user: AuthUser, id: string, q: { page: number; limit: number; status?: WebhookDeliveryStatus }) {
    const endpoint = await this.mine(user, id);
    let query = this.db.selectFrom('webhookDeliveries').where('endpointId', '=', endpoint.id);
    if (q.status) query = query.where('status', '=', q.status);
    const [items, total] = await Promise.all([
      // The stored body is omitted from lists; it can hold guest data and is large.
      query
        .select(['id', 'endpointId', 'eventId', 'eventType', 'status', 'attempts', 'lastStatusCode', 'lastError', 'deliveredAt', 'createdAt', 'updatedAt'])
        .orderBy('createdAt', 'desc')
        .orderBy('id')
        .offset((q.page - 1) * q.limit)
        .limit(q.limit)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: q.page, limit: q.limit, total: Number(total.n) };
  }

  /** Resets a FAILED (or stuck) delivery so it is attempted again with the same event id and body. */
  async redeliver(user: AuthUser, meta: RequestMeta, endpointId: string, deliveryId: string) {
    const endpoint = await this.mine(user, endpointId);
    const d = await this.db
      .updateTable('webhookDeliveries')
      .set({ status: WebhookDeliveryStatus.PENDING, attempts: 0, lockedUntil: null, enqueuedAt: null, lastError: null })
      .where('id', '=', toUuid(deliveryId))
      .where('endpointId', '=', endpoint.id)
      .where('status', 'in', [WebhookDeliveryStatus.FAILED, WebhookDeliveryStatus.RETRYING, WebhookDeliveryStatus.PENDING])
      .returning(['id', 'eventId', 'eventType', 'status', 'attempts'])
      .executeTakeFirst();
    if (!d) throw new NotFoundError('WebhookDelivery', deliveryId);
    await this.audit.log({ user, meta }, { action: 'webhook_delivery.redeliver', entityType: 'WebhookDelivery', entityId: d.id });
    void this.outbox.flush();
    return d;
  }

  private async mine(user: AuthUser, id: string) {
    const e = await this.db.selectFrom('webhookEndpoints').selectAll().where('id', '=', toUuid(id)).where('organizationId', '=', this.orgOf(user)).executeTakeFirst();
    if (!e) throw new NotFoundError('WebhookEndpoint', id);
    return e;
  }

  private orgOf(user: AuthUser): string {
    if (!user.organizationId) throw new DomainValidationError('This account has no organization');
    return user.organizationId;
  }

  private checkUrl(url: string) {
    try {
      validateWebhookUrl(url, this.config.get('publicApi', { infer: true }).webhookAllowPrivateTargets);
    } catch (e) {
      if (e instanceof UnsafeWebhookTargetError) throw new DomainValidationError(e.message, { fields: { url: [e.message] } });
      throw e;
    }
  }

  private checkEvents(events: string[]): string[] {
    const allowed: string[] = [...API_EVENT_TYPES.filter((t) => t !== 'ping'), '*'];
    const bad = events.filter((e) => !allowed.includes(e));
    if (bad.length) throw new DomainValidationError(`Unknown event type(s): ${bad.join(', ')}`, { allowed });
    return [...new Set(events)];
  }

  private async ownedProperties(organizationId: string, ids?: string[]): Promise<string[]> {
    if (!ids?.length) return [];
    const normalized = [...new Set(ids.map((i) => toUuid(i, 'propertyIds')))];
    const found = await this.db.selectFrom('properties').select('id').where('id', 'in', normalized).where('organizationId', '=', organizationId).execute();
    if (found.length !== normalized.length) throw new DomainValidationError('propertyIds must all belong to your organization');
    return normalized;
  }

  private view(d: EndpointRow) {
    return { id: d.id, url: d.url, description: d.description ?? undefined, events: d.events, propertyIds: d.propertyIds, status: d.status, includeGuestDetails: d.includeGuestDetails, createdAt: d.createdAt };
  }
}
