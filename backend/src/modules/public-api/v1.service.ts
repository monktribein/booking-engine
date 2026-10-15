import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RequestMeta } from '../../common/auth/auth-user';
import { toDateOnly } from '../../database/common/dates';
import { apiReservationView } from '../../database/common/api-views';
import { PropertyStatus, ReservationSource, ReservationStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { attachRooms, findReservation, type Reservation } from '../../database/reservation-store';
import { ReservationService } from '../../database/services/reservation.service';
import { d } from '../../database/sql';
import { BookingEngineService, PublicAvailabilityQueryDto, PublicReservationDto } from '../booking-engine/booking-engine.module';
import type { ApiPrincipal } from './api-key.service';

const NO_PROPERTY = '00000000-0000-0000-0000-000000000000';

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
 */
@Injectable()
export class PublicApiV1Service {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly engine: BookingEngineService,
    private readonly reservations: ReservationService,
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

  async availability(p: ApiPrincipal, slug: string, q: PublicAvailabilityQueryDto) {
    await this.propertyBySlug(p, slug);
    return this.engine.search(slug, q, p.organizationId);
  }

  // ------------------------------------------------------------ reservations

  async createReservation(p: ApiPrincipal, dto: PublicReservationDto, idempotencyKey: string, meta: RequestMeta) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
      throw new DomainValidationError('Idempotency-Key must be 8-100 characters of [A-Za-z0-9_-]');
    }
    const property = await this.propertyBySlug(p, dto.propertySlug);
    // Per API key: two clients can use the same key string without ever seeing each other's bookings.
    const scopedKey = `api_${p.apiKeyId}_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
    const result = await this.engine.book(dto, scopedKey, meta, { organizationId: p.organizationId, source: ReservationSource.API, channel: 'public-api-v1' });
    const doc = await findReservation(this.db, { reservationCode: result.reservation.reservationCode, propertyId: property.id });
    if (!doc) throw new NotFoundError('Reservation', result.reservation.reservationCode);
    if (!result.created && !this.sameRequest(doc, dto)) {
      // Same key, different content: refuse instead of silently returning an unrelated booking.
      throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different booking request');
    }
    return { reservation: apiReservationView(doc, property), payment: result.payment, created: result.created };
  }

  async getReservation(p: ApiPrincipal, code: string) {
    const { doc, property } = await this.findReservation(p, code);
    return apiReservationView(doc, property);
  }

  async listReservations(p: ApiPrincipal, q: { propertySlug?: string; status?: ReservationStatus; checkInFrom?: string; checkInTo?: string; page: number; limit: number }) {
    let props = await this.visibleProperties(p);
    if (q.propertySlug) {
      props = props.filter((x) => x.slug === q.propertySlug);
      if (!props.length) throw new NotFoundError('Property', q.propertySlug);
    }
    const byId = new Map(props.map((x) => [x.id, x]));
    let query = this.db.selectFrom('reservations').where('propertyId', 'in', props.length ? props.map((x) => x.id) : [NO_PROPERTY]);
    if (q.status) query = query.where('status', '=', q.status);
    if (q.checkInFrom) query = query.where('checkIn', '>=', d(toDateOnly(q.checkInFrom)));
    if (q.checkInTo) query = query.where('checkIn', '<=', d(toDateOnly(q.checkInTo)));
    const [rows, total] = await Promise.all([
      query.selectAll().orderBy('createdAt', 'desc').orderBy('id', 'desc').offset((q.page - 1) * q.limit).limit(q.limit).execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    const items = await attachRooms(this.db, rows);
    return { items: items.map((r) => apiReservationView(r, byId.get(r.propertyId)!)), page: q.page, limit: q.limit, total: Number(total.n) };
  }

  async cancelReservation(p: ApiPrincipal, code: string, reason: string | undefined) {
    const { doc, property } = await this.findReservation(p, code);
    const res = await this.reservations.cancelReservation({ propertyId: doc.propertyId, reservationId: doc.id, reason: reason?.trim() || 'Cancelled via API', cancelledBy: null });
    return {
      reservation: apiReservationView(res.reservation, property),
      alreadyCancelled: res.alreadyCancelled,
      refunds: res.refunds.map((r) => ({ amount: r.amount, currency: r.currency, status: r.status })),
    };
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

