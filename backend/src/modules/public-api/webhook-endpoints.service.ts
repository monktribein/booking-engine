import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Connection, Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import type { AppConfig } from '../../config/configuration';
import { encryptSecret } from '../../database/common/crypto';
import { API_EVENT_TYPES, WebhookDeliveryStatus, WebhookEndpointStatus } from '../../database/enums';
import { DomainValidationError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import { ClientEventService } from '../../database/services/client-event.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import { UnsafeWebhookTargetError, validateWebhookUrl } from './safe-http';

export interface EndpointInput {
  url?: string;
  description?: string;
  events?: string[];
  propertyIds?: string[];
  status?: WebhookEndpointStatus;
}

const generateSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

@Injectable()
export class WebhookEndpointsService {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditLogger,
    private readonly outbox: OutboxDispatcher,
  ) {
    this.m = getModels(connection);
  }

  async create(user: AuthUser, meta: RequestMeta, input: Required<Pick<EndpointInput, 'url' | 'events'>> & EndpointInput) {
    const organizationId = this.orgOf(user);
    this.checkUrl(input.url);
    const events = this.checkEvents(input.events);
    const propertyIds = await this.ownedProperties(organizationId, input.propertyIds);
    const secret = generateSecret();
    const doc = await this.m.WebhookEndpoint.create({
      organizationId,
      propertyIds,
      url: input.url,
      description: input.description,
      events,
      secretEncrypted: encryptSecret(secret),
      createdBy: user.userId,
    });
    await this.audit.log({ user, meta }, { action: 'webhook_endpoint.create', entityType: 'WebhookEndpoint', entityId: doc._id, after: { url: input.url, events } });
    // The signing secret is returned once, here and on rotation.
    return { ...this.view(doc.toObject()), secret };
  }

  async list(user: AuthUser) {
    const rows = await this.m.WebhookEndpoint.find({ organizationId: this.orgOf(user) }).sort({ createdAt: -1 }).lean();
    return rows.map((r) => this.view(r));
  }

  async update(user: AuthUser, meta: RequestMeta, id: Types.ObjectId, input: EndpointInput) {
    const organizationId = this.orgOf(user);
    const set: Record<string, unknown> = {};
    if (input.url !== undefined) {
      this.checkUrl(input.url);
      set.url = input.url;
    }
    if (input.events !== undefined) set.events = this.checkEvents(input.events);
    if (input.description !== undefined) set.description = input.description;
    if (input.status !== undefined) set.status = input.status;
    if (input.propertyIds !== undefined) set.propertyIds = await this.ownedProperties(organizationId, input.propertyIds);
    const doc = await this.m.WebhookEndpoint.findOneAndUpdate({ _id: id, organizationId }, { $set: set }, { new: true, runValidators: true }).lean();
    if (!doc) throw new NotFoundError('WebhookEndpoint', id);
    await this.audit.log({ user, meta }, { action: 'webhook_endpoint.update', entityType: 'WebhookEndpoint', entityId: id, after: { ...set, propertyIds: undefined } });
    return this.view(doc);
  }

  async remove(user: AuthUser, meta: RequestMeta, id: Types.ObjectId) {
    const organizationId = this.orgOf(user);
    const doc = await this.m.WebhookEndpoint.findOneAndDelete({ _id: id, organizationId }).lean();
    if (!doc) throw new NotFoundError('WebhookEndpoint', id);
    await this.m.WebhookDelivery.deleteMany({ endpointId: id, organizationId });
    await this.audit.log({ user, meta }, { action: 'webhook_endpoint.delete', entityType: 'WebhookEndpoint', entityId: id, before: { url: doc.url } });
    return { ok: true };
  }

  async rotateSecret(user: AuthUser, meta: RequestMeta, id: Types.ObjectId) {
    const secret = generateSecret();
    const doc = await this.m.WebhookEndpoint.findOneAndUpdate({ _id: id, organizationId: this.orgOf(user) }, { $set: { secretEncrypted: encryptSecret(secret) } }, { new: true }).lean();
    if (!doc) throw new NotFoundError('WebhookEndpoint', id);
    await this.audit.log({ user, meta }, { action: 'webhook_endpoint.rotate_secret', entityType: 'WebhookEndpoint', entityId: id });
    return { ...this.view(doc), secret };
  }

  /** Queues a signed `ping` so integrators can verify their receiver and signature code. */
  async sendTest(user: AuthUser, id: Types.ObjectId) {
    const endpoint = await this.mine(user, id);
    const eventId = ClientEventService.eventId('ping', endpoint._id, randomBytes(8).toString('hex'));
    const body = ClientEventService.buildBody(eventId, 'ping', { message: 'This is a test event from Tirvona.' });
    const delivery = await this.m.WebhookDelivery.create({ organizationId: endpoint.organizationId, endpointId: endpoint._id, eventId, eventType: 'ping', body });
    void this.outbox.flush();
    return { deliveryId: delivery._id, eventId };
  }

  async deliveries(user: AuthUser, id: Types.ObjectId, q: { page: number; limit: number; status?: WebhookDeliveryStatus }) {
    const endpoint = await this.mine(user, id);
    const filter = { endpointId: endpoint._id, ...(q.status ? { status: q.status } : {}) };
    const [items, total] = await Promise.all([
      // The stored body is omitted from lists; it can hold guest data and is large.
      this.m.WebhookDelivery.find(filter, { body: 0 })
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      this.m.WebhookDelivery.countDocuments(filter),
    ]);
    return { items, page: q.page, limit: q.limit, total };
  }

  /** Resets a FAILED (or stuck) delivery so it is attempted again with the same event id and body. */
  async redeliver(user: AuthUser, meta: RequestMeta, endpointId: Types.ObjectId, deliveryId: Types.ObjectId) {
    const endpoint = await this.mine(user, endpointId);
    const d = await this.m.WebhookDelivery.findOneAndUpdate(
      { _id: deliveryId, endpointId: endpoint._id, status: { $in: [WebhookDeliveryStatus.FAILED, WebhookDeliveryStatus.RETRYING, WebhookDeliveryStatus.PENDING] } },
      { $set: { status: WebhookDeliveryStatus.PENDING, attempts: 0, lockedUntil: null, enqueuedAt: null }, $unset: { lastError: 1 } },
      { new: true, projection: { body: 0 } },
    ).lean();
    if (!d) throw new NotFoundError('WebhookDelivery', deliveryId);
    await this.audit.log({ user, meta }, { action: 'webhook_delivery.redeliver', entityType: 'WebhookDelivery', entityId: deliveryId });
    void this.outbox.flush();
    return d;
  }

  private async mine(user: AuthUser, id: Types.ObjectId) {
    const e = await this.m.WebhookEndpoint.findOne({ _id: id, organizationId: this.orgOf(user) }).lean();
    if (!e) throw new NotFoundError('WebhookEndpoint', id);
    return e;
  }

  private orgOf(user: AuthUser): Types.ObjectId {
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

  private async ownedProperties(organizationId: Types.ObjectId, ids?: string[]): Promise<Types.ObjectId[]> {
    if (!ids?.length) return [];
    const oids = ids.map((i) => new Types.ObjectId(i));
    const found = await this.m.Property.countDocuments({ _id: { $in: oids }, organizationId });
    if (found !== new Set(ids).size) throw new DomainValidationError('propertyIds must all belong to your organization');
    return oids;
  }

  private view(d: { _id: Types.ObjectId; url: string; description?: string; events: string[]; propertyIds: Types.ObjectId[]; status: string; createdAt: Date }) {
    return { _id: d._id, url: d.url, description: d.description, events: d.events, propertyIds: d.propertyIds, status: d.status, createdAt: d.createdAt };
  }
}
