import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Connection } from 'mongoose';
import type { RequestMeta } from '../../common/auth/auth-user';
import { toDateOnly } from '../../database/common/dates';
import { apiReservationView } from '../../database/common/api-views';
import { PropertyStatus, ReservationSource, ReservationStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { Property } from '../../database/schemas/property.schema';
import type { Reservation } from '../../database/schemas/reservation.schema';
import { ReservationService } from '../../database/services/reservation.service';
import { BookingEngineService, PublicAvailabilityQueryDto, PublicReservationDto } from '../booking-engine/booking-engine.module';
import type { ApiPrincipal } from './api-key.service';

type TenantProperty = Pick<Property, '_id' | 'slug' | 'name' | 'organizationId'>;

/**
 * Business logic of /v1. Every method takes the ApiPrincipal and resolves properties through
 * `visibleProperties`, the single place that applies tenant isolation (organization + the key's optional
 * property restriction). A resource outside it is reported as 404, never 403, so keys cannot probe for
 * the existence of other tenants' data.
 */
@Injectable()
export class PublicApiV1Service {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly engine: BookingEngineService,
    private readonly reservations: ReservationService,
  ) {
    this.m = getModels(connection);
  }

  private async visibleProperties(p: ApiPrincipal, extra: Record<string, unknown> = {}): Promise<TenantProperty[]> {
    return this.m.Property.find(
      { organizationId: p.organizationId, ...(p.propertyIds.length ? { _id: { $in: p.propertyIds } } : {}), ...extra },
      { slug: 1, name: 1, organizationId: 1 },
    ).lean();
  }

  private async propertyBySlug(p: ApiPrincipal, slug: string): Promise<TenantProperty> {
    const [prop] = await this.visibleProperties(p, { slug, status: PropertyStatus.ACTIVE });
    if (!prop) throw new NotFoundError('Property', slug);
    return prop;
  }

  // ------------------------------------------------------------ properties and availability

  async listProperties(p: ApiPrincipal) {
    const rows = await this.m.Property.find(
      { organizationId: p.organizationId, status: PropertyStatus.ACTIVE, ...(p.propertyIds.length ? { _id: { $in: p.propertyIds } } : {}) },
      { slug: 1, name: 1, city: 1, state: 1, country: 1, currency: 1, timezone: 1 },
    )
      .sort({ name: 1 })
      .lean();
    return rows.map((r) => ({ id: String(r._id), slug: r.slug, name: r.name, city: r.city, state: r.state, country: r.country, currency: r.currency, timezone: r.timezone }));
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
    const scopedKey = `api_${String(p.apiKeyId)}_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
    const result = await this.engine.book(dto, scopedKey, meta, { organizationId: p.organizationId, source: ReservationSource.API, channel: 'public-api-v1' });
    const doc = await this.m.Reservation.findOne({ reservationCode: result.reservation.reservationCode, propertyId: property._id }).lean();
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
    const byId = new Map(props.map((x) => [String(x._id), x]));
    const filter: Record<string, unknown> = { propertyId: { $in: props.map((x) => x._id) } };
    if (q.status) filter.status = q.status;
    if (q.checkInFrom || q.checkInTo) {
      filter.checkIn = { ...(q.checkInFrom ? { $gte: toDateOnly(q.checkInFrom) } : {}), ...(q.checkInTo ? { $lte: toDateOnly(q.checkInTo) } : {}) };
    }
    const [rows, total] = await Promise.all([
      this.m.Reservation.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      this.m.Reservation.countDocuments(filter),
    ]);
    return { items: rows.map((r) => apiReservationView(r, byId.get(String(r.propertyId))!)), page: q.page, limit: q.limit, total };
  }

  async cancelReservation(p: ApiPrincipal, code: string, reason: string | undefined) {
    const { doc, property } = await this.findReservation(p, code);
    const res = await this.reservations.cancelReservation({ propertyId: doc.propertyId, reservationId: doc._id, reason: reason?.trim() || 'Cancelled via API', cancelledBy: null });
    return {
      reservation: apiReservationView(res.reservation, property),
      alreadyCancelled: res.alreadyCancelled,
      refunds: res.refunds.map((r) => ({ amount: r.amount, currency: r.currency, status: r.status })),
    };
  }

  private async findReservation(p: ApiPrincipal, rawCode: string) {
    const props = await this.visibleProperties(p);
    const doc = await this.m.Reservation.findOne({ reservationCode: rawCode.toUpperCase(), propertyId: { $in: props.map((x) => x._id) } }).lean();
    const property = doc && props.find((x) => x._id.equals(doc.propertyId));
    if (!doc || !property) throw new NotFoundError('Reservation', rawCode);
    return { doc, property };
  }

  /** Does the stored reservation match what this request asks for? (stay, guest e-mail, room lines) */
  private sameRequest(r: Reservation, dto: PublicReservationDto): boolean {
    const norm = (lines: { roomTypeId: string; ratePlanId: string; quantity: number }[]) =>
      lines.map((l) => `${l.roomTypeId}:${l.ratePlanId}:${l.quantity}`).sort().join('|');
    const stored = norm(r.reservationRooms.map((l) => ({ roomTypeId: String(l.roomTypeId), ratePlanId: String(l.ratePlanId), quantity: l.quantity })));
    const asked = norm(dto.rooms.map((l) => ({ roomTypeId: l.roomTypeId, ratePlanId: l.ratePlanId, quantity: l.quantity })));
    return (
      r.checkIn.getTime() === toDateOnly(dto.checkIn).getTime() &&
      r.checkOut.getTime() === toDateOnly(dto.checkOut).getTime() &&
      (r.guest.email ?? '').toLowerCase() === dto.guest.email.trim().toLowerCase() &&
      stored === asked
    );
  }
}

