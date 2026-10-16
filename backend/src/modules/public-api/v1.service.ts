import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RequestMeta } from '../../common/auth/auth-user';
import { addDays, eachNight, formatDateOnly, todayIn, toDateOnly } from '../../database/common/dates';
import { apiReservationView, paymentSummary, redactGuest } from '../../database/common/api-views';
import { isChannelSource, PropertyStatus, RatePlanStatus, ReservationSource, ReservationStatus, SyncEntityType, SyncJobType } from '../../database/enums';
import { ConflictError, DomainError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, runInTransaction } from '../../database/kysely';
import { attachRooms, findReservation, type Reservation } from '../../database/reservation-store';
import { AuditService } from '../../database/services/audit.service';
import { InventoryService } from '../../database/services/inventory.service';
import { ReservationService } from '../../database/services/reservation.service';
import { SyncJobService } from '../../database/services/sync-job.service';
import { d } from '../../database/sql';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { BookingEngineService, PublicAvailabilityQueryDto, PublicReservationDto } from '../booking-engine/booking-engine.module';
import type { SetRestrictionsDto } from '../inventory/inventory.dto';
import type { ApiPrincipal } from './api-key.service';

/** The body of PATCH /v1/reservations/{code}: every field optional. */
export interface UpdateReservationInput {
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  specialRequests?: string;
  guest?: { firstName?: string; lastName?: string; email?: string; phone?: string };
}

const NO_PROPERTY = '00000000-0000-0000-0000-000000000000';

/** Bookings that belong to an external channel: the channel owns them, so they are changed or cancelled there, not through the API. */

interface TenantProperty {
  id: string;
  slug: string;
  name: string;
  organizationId: string;
}

/**
 * Business logic of /v1. Every method takes the ApiPrincipal and resolves properties through
 * `visibleProperties`, the single place that applies tenant isolation (organization + the key's optional
 * property restriction). A resource outside it is reported as 404, never 403, so keys cannot probe for
 * the existence of other tenants' data.
 *
 * Who owns what: Tirvona owns inventory, prices and the booking record; the partner software owns the guest relationship and
 * its own reference (`externalReference`); an external channel owns its own bookings. See docs/INTEGRATION_GUIDE.md.
 */
@Injectable()
export class PublicApiV1Service {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly engine: BookingEngineService,
    private readonly reservations: ReservationService,
    private readonly inventory: InventoryService,
    private readonly syncJobs: SyncJobService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  private async visibleProperties(p: ApiPrincipal, extra: { slug?: string; active?: boolean } = {}): Promise<TenantProperty[]> {
    let q = this.db.selectFrom('properties').select(['id', 'slug', 'name', 'organizationId']).where('organizationId', '=', p.organizationId);
    if (p.propertyIds.length) q = q.where('id', 'in', p.propertyIds);
    if (extra.slug) q = q.where('slug', '=', extra.slug);
    if (extra.active) q = q.where('status', '=', PropertyStatus.ACTIVE);
    return q.execute();
  }

  private async propertyBySlug(p: ApiPrincipal, slug: string): Promise<TenantProperty> {
    const [prop] = await this.visibleProperties(p, { slug, active: true });
    if (!prop) throw new NotFoundError('Property', slug);
    return prop;
  }

  /** Every write through the API leaves an audit row naming the key (never the secret). */
  private auditWrite(p: ApiPrincipal, meta: RequestMeta, rec: { action: string; propertyId: string; entityType: string; entityId: string; after?: Record<string, unknown>; before?: Record<string, unknown> }, tx: Db | null = null) {
    return this.audit.record(tx, { organizationId: p.organizationId, userId: null, ...rec, metadata: { apiKeyId: p.apiKeyId, via: 'public-api-v1', ip: meta.ip } });
  }

  /**
   * Guest contact details and free-text requests are returned only to keys that hold `guests:read`, or for bookings the same
   * key created (it already has that information). Everything else sees first name and last initial.
   */
  private view(p: ApiPrincipal, r: Reservation, property: Pick<TenantProperty, 'slug' | 'name'>) {
    const v = apiReservationView(r, property);
    return p.scopes.includes('guests:read') || r.apiKeyId === p.apiKeyId ? v : redactGuest(v);
  }

  // ------------------------------------------------------------ properties and availability

  async listProperties(p: ApiPrincipal) {
    let q = this.db
      .selectFrom('properties')
      .select(['id', 'slug', 'name', 'city', 'state', 'country', 'currency', 'timezone'])
      .where('organizationId', '=', p.organizationId)
      .where('status', '=', PropertyStatus.ACTIVE);
    if (p.propertyIds.length) q = q.where('id', 'in', p.propertyIds);
    const rows = await q.orderBy('name').execute();
    return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, city: r.city, state: r.state, country: r.country, currency: r.currency, timezone: r.timezone }));
  }

  async getProperty(p: ApiPrincipal, slug: string) {
    await this.propertyBySlug(p, slug);
    return this.engine.property(slug, p.organizationId);
  }

  /** Status and capabilities of the property's channel connections. Nothing a partner could use against the channel or the owner. */
  async listConnections(p: ApiPrincipal, slug: string) {
    const property = await this.propertyBySlug(p, slug);
    const rows = await this.db
      .selectFrom('channelConnections as c')
      .leftJoin('channelProviders as pr', 'pr.id', 'c.providerId')
      .leftJoin('channelProviderVersions as v', 'v.id', 'c.providerVersionId')
      .select(['c.channel', 'c.status', 'c.lastSyncAt', 'c.lastError', 'c.lastPollError', 'pr.name', 'pr.protocol', 'v.definition'])
      .where('c.propertyId', '=', property.id)
      .where('c.status', '<>', 'DISCONNECTED')
      .orderBy('c.channel')
      .execute();
    return rows.map((r) => {
      const def = r.definition as { capabilities?: Record<string, boolean> } | null;
      const capabilities = r.protocol === 'ICAL' ? ['listings', 'pullReservations', 'polling'] : def?.capabilities ? Object.entries(def.capabilities).filter(([, on]) => on).map(([k]) => k) : [];
      return { channel: r.channel, name: r.name ?? r.channel, protocol: r.protocol ?? 'CODE', status: r.status, capabilities, lastSyncAt: r.lastSyncAt ? r.lastSyncAt.toISOString() : null, healthy: r.status === 'CONNECTED' && !r.lastError && !r.lastPollError };
    });
  }

  async availability(p: ApiPrincipal, slug: string, q: PublicAvailabilityQueryDto) {
    await this.propertyBySlug(p, slug);
    return this.engine.search(slug, q, p.organizationId);
  }

  // ------------------------------------------------------------ rate plans and prices

  async listRatePlans(p: ApiPrincipal, slug: string) {
    const property = await this.propertyBySlug(p, slug);
    const rows = await this.db
      .selectFrom('ratePlans as rp')
      .innerJoin('roomTypes as rt', 'rt.id', 'rp.roomTypeId')
      .select(['rp.id', 'rp.roomTypeId', 'rt.name as roomTypeName', 'rp.code', 'rp.name', 'rp.type', 'rp.basePrice', 'rp.currency', 'rp.mealPlan', 'rp.status', 'rp.cancellationPolicy'])
      .where('rp.propertyId', '=', property.id)
      .where('rp.status', '<>', RatePlanStatus.ARCHIVED)
      .orderBy('rt.name')
      .orderBy('rp.code')
      .execute();
    return rows.map((r) => ({ id: r.id, roomTypeId: r.roomTypeId, roomTypeName: r.roomTypeName, code: r.code, name: r.name, type: r.type, basePrice: r.basePrice, currency: r.currency, mealPlan: r.mealPlan, status: r.status, cancellationPolicy: r.cancellationPolicy }));
  }

  /**
   * Changes the nightly base price (minor units) of rate plans. Existing reservations keep the price they were sold at; the new
   * price applies to future quotes and bookings, and is queued for every connected channel.
   */
  async updateRates(p: ApiPrincipal, slug: string, updates: { ratePlanId: string; basePrice: number }[], meta: RequestMeta) {
    const property = await this.propertyBySlug(p, slug);
    if (new Set(updates.map((u) => u.ratePlanId)).size !== updates.length) throw new DomainValidationError('Each rate plan may appear once per request');
    const prop = await this.db.selectFrom('properties').select(['timezone', 'bookingHorizonDays']).where('id', '=', property.id).executeTakeFirstOrThrow();
    const plans = await this.db.selectFrom('ratePlans').select(['id', 'roomTypeId', 'basePrice', 'status']).where('propertyId', '=', property.id).where('id', 'in', updates.map((u) => u.ratePlanId)).execute();
    const byId = new Map(plans.map((x) => [x.id, x]));
    for (const u of updates) {
      const plan = byId.get(u.ratePlanId);
      if (!plan) throw new NotFoundError('RatePlan', u.ratePlanId); // another property's plan is a 404, never a hint
      if (plan.status === RatePlanStatus.ARCHIVED) throw new ConflictError('INVALID_STATE_TRANSITION', 'Archived rate plans cannot be edited');
    }
    await runInTransaction(this.db, async (tx) => {
      const today = todayIn(prop.timezone);
      const touched = new Set<string>();
      for (const u of updates) {
        const plan = byId.get(u.ratePlanId)!;
        if (plan.basePrice === u.basePrice) continue; // a repeated request changes nothing (idempotent)
        await tx.updateTable('ratePlans').set({ basePrice: u.basePrice }).where('id', '=', plan.id).execute();
        touched.add(plan.roomTypeId);
        await this.auditWrite(p, meta, { action: 'api.rate_plan_update', propertyId: property.id, entityType: 'RatePlan', entityId: plan.id, before: { basePrice: plan.basePrice }, after: { basePrice: u.basePrice } }, tx);
      }
      for (const roomTypeId of touched) {
        await this.syncJobs.enqueueForRoomType(tx, { propertyId: property.id, roomTypeId, types: [SyncJobType.RATES], dateFrom: today, dateTo: addDays(today, prop.bookingHorizonDays), entityType: SyncEntityType.RATE_PLAN, entityId: roomTypeId });
      }
    });
    void this.outbox.flush();
    return this.listRatePlans(p, slug);
  }

  // ------------------------------------------------------------ inventory and restrictions

  async getInventory(p: ApiPrincipal, slug: string, q: { from: string; to: string; roomTypeId?: string }) {
    const property = await this.propertyBySlug(p, slug);
    const from = toDateOnly(q.from);
    const to = toDateOnly(q.to);
    const nights = eachNight(from, to).length;
    if (nights < 1 || nights > 366) throw new DomainValidationError('The range must be 1 to 366 nights');
    let query = this.db
      .selectFrom('inventory as i')
      .innerJoin('roomTypes as rt', 'rt.id', 'i.roomTypeId')
      .leftJoin('restrictions as r', (j) => j.onRef('r.propertyId', '=', 'i.propertyId').onRef('r.roomTypeId', '=', 'i.roomTypeId').onRef('r.date', '=', 'i.date'))
      .select(['i.roomTypeId', 'rt.name as roomTypeName', 'i.date', 'i.total', 'i.sold', 'i.blocked', 'i.overbooked', 'i.available', 'i.stopSell', 'r.minimumStay', 'r.maximumStay', 'r.closed', 'r.closedToArrival', 'r.closedToDeparture'])
      .where('i.propertyId', '=', property.id)
      .where('i.date', '>=', d(from))
      .where('i.date', '<', d(to));
    if (q.roomTypeId) query = query.where('i.roomTypeId', '=', q.roomTypeId);
    const rows = await query.orderBy('rt.name').orderBy('i.date').execute();
    const out = new Map<string, { roomTypeId: string; roomTypeName: string; days: unknown[] }>();
    for (const r of rows) {
      const rt = out.get(r.roomTypeId) ?? { roomTypeId: r.roomTypeId, roomTypeName: r.roomTypeName, days: [] };
      rt.days.push({
        date: formatDateOnly(r.date),
        total: r.total,
        sold: r.sold,
        blocked: r.blocked,
        overbooked: r.overbooked,
        available: r.available,
        stopSell: r.stopSell,
        restrictions: { minimumStay: r.minimumStay ?? null, maximumStay: r.maximumStay ?? null, closed: r.closed ?? false, closedToArrival: r.closedToArrival ?? false, closedToDeparture: r.closedToDeparture ?? false },
      });
      out.set(r.roomTypeId, rt);
    }
    return { propertySlug: property.slug, from: q.from, to: q.to, roomTypes: [...out.values()] };
  }

  /**
   * Sets stay restrictions and stop-sell for a room type over [from, to). Room counts and physical rooms are not managed through
   * the API. Each change is queued to connected channels and announced with `inventory.updated`.
   */
  async setInventory(p: ApiPrincipal, slug: string, dto: SetRestrictionsDto, meta: RequestMeta) {
    const property = await this.propertyBySlug(p, slug);
    const { roomTypeId, from, to, ...patch } = dto;
    const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(fields).length) throw new DomainValidationError('Send at least one of: minimumStay, maximumStay, closed, closedToArrival, closedToDeparture, stopSell');
    const rt = await this.db.selectFrom('roomTypes').select('id').where('id', '=', roomTypeId).where('propertyId', '=', property.id).executeTakeFirst();
    if (!rt) throw new NotFoundError('RoomType', roomTypeId);
    await this.inventory.setRestrictions({ propertyId: property.id, roomTypeId, from, to, patch: fields, userId: null });
    await this.auditWrite(p, meta, { action: 'api.inventory_update', propertyId: property.id, entityType: 'RoomType', entityId: roomTypeId, after: { from, to, ...fields } });
    void this.outbox.flush();
    return { roomTypeId, from, to, applied: fields };
  }

  // ------------------------------------------------------------ reservations

  async createReservation(p: ApiPrincipal, dto: PublicReservationDto & { externalReference?: string }, idempotencyKey: string, meta: RequestMeta) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
      throw new DomainValidationError('Idempotency-Key must be 8-100 characters of [A-Za-z0-9_-]');
    }
    const property = await this.propertyBySlug(p, dto.propertySlug);
    // Per API key: two clients can use the same key string without ever seeing each other's bookings.
    const scopedKey = `api_${p.apiKeyId}_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
    const result = await this.engine.book(dto, scopedKey, meta, {
      organizationId: p.organizationId,
      source: ReservationSource.API,
      channel: 'public-api-v1',
      apiKeyId: p.apiKeyId,
      partnerReference: dto.externalReference,
    });
    const doc = await findReservation(this.db, { reservationCode: result.reservation.reservationCode, propertyId: property.id });
    if (!doc) throw new NotFoundError('Reservation', result.reservation.reservationCode);
    if (!result.created && !this.sameRequest(doc, dto)) {
      // Same key or reference, different content: refuse instead of silently returning an unrelated booking.
      if (dto.externalReference && doc.partnerReference === dto.externalReference) {
        throw new ConflictError('EXTERNAL_REFERENCE_REUSED', 'This externalReference already belongs to a different booking of this property');
      }
      throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different booking request');
    }
    if (result.created) await this.auditWrite(p, meta, { action: 'api.reservation_create', propertyId: property.id, entityType: 'Reservation', entityId: doc.id, after: { reservationCode: doc.reservationCode, externalReference: doc.partnerReference } });
    return { reservation: this.view(p, doc, property), payment: result.payment, created: result.created };
  }

  async getReservation(p: ApiPrincipal, code: string) {
    const { doc, property } = await this.findReservation(p, code);
    return this.view(p, doc, property);
  }

  async listReservations(p: ApiPrincipal, q: { propertySlug?: string; status?: ReservationStatus; externalReference?: string; checkInFrom?: string; checkInTo?: string; page: number; limit: number }) {
    let props = await this.visibleProperties(p);
    if (q.propertySlug) {
      props = props.filter((x) => x.slug === q.propertySlug);
      if (!props.length) throw new NotFoundError('Property', q.propertySlug);
    }
    const byId = new Map(props.map((x) => [x.id, x]));
    let query = this.db.selectFrom('reservations').where('propertyId', 'in', props.length ? props.map((x) => x.id) : [NO_PROPERTY]);
    if (q.status) query = query.where('status', '=', q.status);
    if (q.externalReference) query = query.where('partnerReference', '=', q.externalReference);
    if (q.checkInFrom) query = query.where('checkIn', '>=', d(toDateOnly(q.checkInFrom)));
    if (q.checkInTo) query = query.where('checkIn', '<=', d(toDateOnly(q.checkInTo)));
    const [rows, total] = await Promise.all([
      query.selectAll().orderBy('createdAt', 'desc').orderBy('id', 'desc').offset((q.page - 1) * q.limit).limit(q.limit).execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    const items = await attachRooms(this.db, rows);
    return { items: items.map((r) => this.view(p, r, byId.get(r.propertyId)!)), page: q.page, limit: q.limit, total: Number(total.n) };
  }

  /** Change dates, guest counts, contact details or notes of a booking the platform or your software made (not a channel's booking). */
  async updateReservation(p: ApiPrincipal, code: string, dto: UpdateReservationInput, meta: RequestMeta) {
    const { doc, property } = await this.findReservation(p, code);
    this.assertNotChannelOwned(doc);
    if (![ReservationStatus.PENDING, ReservationStatus.CONFIRMED].includes(doc.status as ReservationStatus)) {
      throw new ConflictError('INVALID_STATE_TRANSITION', `A ${doc.status.toLowerCase().replace('_', ' ')} reservation cannot be modified`);
    }
    if (!Object.values(dto).some((v) => v !== undefined)) throw new DomainValidationError('Send at least one field to change');
    const updated = await this.reservations.updateReservation({
      propertyId: doc.propertyId,
      reservationId: doc.id,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      adults: dto.adults,
      children: dto.children,
      specialRequests: dto.specialRequests,
      guest: dto.guest,
      userId: null,
    });
    await this.auditWrite(p, meta, { action: 'api.reservation_update', propertyId: doc.propertyId, entityType: 'Reservation', entityId: doc.id, after: { fields: Object.keys(dto) } });
    void this.outbox.flush();
    return this.view(p, updated, property);
  }

  async cancelReservation(p: ApiPrincipal, code: string, reason: string | undefined, meta: RequestMeta) {
    const { doc, property } = await this.findReservation(p, code);
    this.assertNotChannelOwned(doc);
    const res = await this.reservations.cancelReservation({ propertyId: doc.propertyId, reservationId: doc.id, reason: reason?.trim() || 'Cancelled via API', cancelledBy: null });
    if (!res.alreadyCancelled) await this.auditWrite(p, meta, { action: 'api.reservation_cancel', propertyId: doc.propertyId, entityType: 'Reservation', entityId: doc.id, after: { reason: reason?.trim() } });
    return {
      reservation: this.view(p, res.reservation, property),
      alreadyCancelled: res.alreadyCancelled,
      refunds: res.refunds.map((r) => ({ amount: r.amount, currency: r.currency, status: r.status })),
    };
  }

  /** Payments and refunds of one reservation (needs `payments:read`). No gateway metadata, no secrets. */
  async reservationPayments(p: ApiPrincipal, code: string) {
    const { doc } = await this.findReservation(p, code);
    const [payments, refunds] = await Promise.all([
      this.db.selectFrom('payments').selectAll().where('reservationId', '=', doc.id).orderBy('createdAt').execute(),
      this.db.selectFrom('refunds').select(['id', 'paymentId', 'amount', 'currency', 'status', 'reason', 'processedAt', 'createdAt']).where('reservationId', '=', doc.id).orderBy('createdAt').execute(),
    ]);
    return {
      reservationCode: doc.reservationCode,
      currency: doc.currency,
      total: doc.total,
      amountPaid: doc.amountPaid,
      amountRefunded: doc.amountRefunded,
      paymentStatus: doc.paymentStatus,
      payments: payments.map((x) => ({ ...paymentSummary(x), createdAt: x.createdAt })),
      refunds: refunds.map((x) => ({ id: x.id, paymentId: x.paymentId, amount: x.amount, currency: x.currency, status: x.status, reason: x.reason, processedAt: x.processedAt, createdAt: x.createdAt })),
    };
  }

  private assertNotChannelOwned(r: Reservation) {
    if (isChannelSource(r.source)) {
      throw new DomainError('CHANNEL_OWNED_RESERVATION', `This reservation came from ${r.source} and is changed there. Tirvona applies the channel's change automatically.`);
    }
  }

  private async findReservation(p: ApiPrincipal, rawCode: string) {
    const props = await this.visibleProperties(p);
    const row = props.length
      ? await this.db.selectFrom('reservations').selectAll().where('reservationCode', '=', rawCode.toUpperCase()).where('propertyId', 'in', props.map((x) => x.id)).executeTakeFirst()
      : undefined;
    const doc = row ? (await attachRooms(this.db, [row]))[0] : null;
    const property = doc && props.find((x) => x.id === doc.propertyId);
    if (!doc || !property) throw new NotFoundError('Reservation', rawCode);
    return { doc, property };
  }

  /** Does the stored reservation match what this request asks for? (stay, guest e-mail, room lines) */
  private sameRequest(r: Reservation, dto: PublicReservationDto): boolean {
    const norm = (lines: { roomTypeId: string; ratePlanId: string; quantity: number }[]) =>
      lines.map((l) => `${l.roomTypeId}:${l.ratePlanId}:${l.quantity}`).sort().join('|');
    const stored = norm(r.reservationRooms.map((l) => ({ roomTypeId: l.roomTypeId, ratePlanId: String(l.ratePlanId), quantity: l.quantity })));
    const asked = norm(dto.rooms.map((l) => ({ roomTypeId: l.roomTypeId, ratePlanId: l.ratePlanId, quantity: l.quantity })));
    return (
      r.checkIn.getTime() === toDateOnly(dto.checkIn).getTime() &&
      r.checkOut.getTime() === toDateOnly(dto.checkOut).getTime() &&
      (r.guest.email ?? '').toLowerCase() === dto.guest.email.trim().toLowerCase() &&
      stored === asked
    );
  }
}
