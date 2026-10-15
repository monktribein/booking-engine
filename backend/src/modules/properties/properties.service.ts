import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PropertyAccessService } from '../../common/access/property-access.service';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { Page, pageParams, slugify, toUuid } from '../../common/utils';
import { isValidTimeZone, todayIn } from '../../database/common/dates';
import type { Image, Property } from '../../database/db-types';
import { ACTIVE_RESERVATION_STATUSES, PropertyStatus, PropertyUserRole, UserRole } from '../../database/enums';
import { ConflictError, DomainValidationError, ForbiddenError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, isUniqueViolation, j, runInTransaction } from '../../database/kysely';
import { d } from '../../database/sql';
import { AuditLogger } from '../audit/audit.logger';
import type { CreatePropertyDto, ImageDto, UpdatePropertyDto } from './dto/property.dto';

export const normalizeImages = (images: ImageDto[] | undefined): Image[] | undefined =>
  images?.map((i, n) => ({ url: i.url.trim(), ...(i.caption ? { caption: i.caption.trim() } : {}), sortOrder: i.sortOrder ?? n }));

const trimAll = (a: string[] | undefined) => a?.map((x) => x.trim()).filter(Boolean);

@Injectable()
export class PropertiesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: PropertyAccessService,
    private readonly audit: AuditLogger,
  ) {}

  async list(user: AuthUser, page = 1, limit = 20): Promise<Page<Property>> {
    const ids = await this.access.accessiblePropertyIds(user);
    const p = pageParams(page, limit);
    if (ids && !ids.length) return { items: [], page: p.page, limit: p.limit, total: 0 };
    let q = this.db.selectFrom('properties').where('status', '<>', PropertyStatus.ARCHIVED);
    if (ids) q = q.where('id', 'in', ids);
    const [items, total] = await Promise.all([
      q.selectAll().orderBy('name').orderBy('id').offset(p.skip).limit(p.limit).execute(),
      q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  async get(propertyId: string): Promise<Property> {
    const p = await this.db.selectFrom('properties').selectAll().where('id', '=', propertyId).executeTakeFirst();
    if (!p) throw new NotFoundError('Property', propertyId);
    return p;
  }

  /** Creates the property and makes the creator its PROPERTY_OWNER, atomically. */
  async create(user: AuthUser, meta: RequestMeta, dto: CreatePropertyDto): Promise<Property> {
    let organizationId: string;
    if (user.role === UserRole.SUPER_ADMIN) {
      if (!dto.organizationId) throw new DomainValidationError('organizationId is required for SUPER_ADMIN');
      organizationId = toUuid(dto.organizationId, 'organizationId');
    } else if (user.role === UserRole.PROPERTY_OWNER && user.organizationId) {
      organizationId = user.organizationId;
    } else {
      throw new ForbiddenError('Only property owners can create properties');
    }
    if (!isValidTimeZone(dto.timezone)) throw new DomainValidationError(`${dto.timezone} is not a valid IANA time zone`, { fields: { timezone: ['is not a valid IANA time zone'] } });
    if ((dto.latitude == null) !== (dto.longitude == null)) throw new DomainValidationError('latitude and longitude must be set together');
    const slug = dto.slug ?? `${slugify(dto.name) || 'property'}-${randomBytes(2).toString('hex')}`;
    try {
      return await runInTransaction(this.db, async (tx) => {
        const p = await tx
          .insertInto('properties')
          .values({
            organizationId,
            ownerId: user.userId,
            name: dto.name.trim(),
            slug,
            description: dto.description ?? null,
            address: dto.address.trim(),
            city: dto.city.trim(),
            state: dto.state.trim(),
            country: dto.country,
            postalCode: dto.postalCode.trim(),
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            timezone: dto.timezone,
            currency: dto.currency,
            ...(dto.checkInTime ? { checkInTime: dto.checkInTime } : {}),
            ...(dto.checkOutTime ? { checkOutTime: dto.checkOutTime } : {}),
            ...(dto.taxPercent !== undefined ? { taxPercent: dto.taxPercent } : {}),
            ...(dto.bookingHorizonDays !== undefined ? { bookingHorizonDays: dto.bookingHorizonDays } : {}),
            images: j(normalizeImages(dto.images) ?? []),
            amenities: trimAll(dto.amenities) ?? [],
            status: dto.status ?? PropertyStatus.ACTIVE,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (user.role !== UserRole.SUPER_ADMIN) {
          await tx.insertInto('propertyUsers').values({ propertyId: p.id, userId: user.userId, role: PropertyUserRole.PROPERTY_OWNER }).execute();
        }
        await this.audit.log({ user, meta }, { action: 'property.create', entityType: 'Property', entityId: p.id, propertyId: p.id, organizationId, after: { name: p.name, slug } }, tx);
        return p;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'properties_slug_key')) throw new ConflictError('SLUG_TAKEN', `The slug "${slug}" is already in use`);
      throw err;
    }
  }

  async update(user: AuthUser, meta: RequestMeta, propertyId: string, dto: UpdatePropertyDto): Promise<Property> {
    const before = await this.get(propertyId);
    if (before.status === PropertyStatus.ARCHIVED) throw new DomainValidationError('Archived properties cannot be edited');
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      if (k === 'images') set.images = j(normalizeImages(v as ImageDto[]) ?? []);
      else if (k === 'amenities') set.amenities = trimAll(v as string[]) ?? [];
      else if (typeof v === 'string') set[k] = v.trim();
      else set[k] = v;
    }
    const lat = 'latitude' in set ? set.latitude : before.latitude;
    const lng = 'longitude' in set ? set.longitude : before.longitude;
    if ((lat == null) !== (lng == null)) throw new DomainValidationError('latitude and longitude must be set together');
    try {
      const after = Object.keys(set).length
        ? await this.db.updateTable('properties').set(set).where('id', '=', propertyId).returningAll().executeTakeFirstOrThrow()
        : before;
      await this.audit.log({ user, meta }, {
        action: 'property.update',
        entityType: 'Property',
        entityId: propertyId,
        propertyId,
        before: pick(before, Object.keys(dto)),
        after: pick(after, Object.keys(dto)),
      });
      return after;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('SLUG_TAKEN', 'This slug is already in use');
      throw err;
    }
  }

  /**
   * Soft delete: ARCHIVED. Refused while guests are booked for future nights, because archiving would strand them.
   * Cancel or move those bookings first.
   */
  async archive(user: AuthUser, meta: RequestMeta, propertyId: string): Promise<Property> {
    const property = await this.get(propertyId);
    const upcoming = Number(
      (
        await this.db
          .selectFrom('reservations')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('propertyId', '=', propertyId)
          .where('status', 'in', [...ACTIVE_RESERVATION_STATUSES])
          .where('checkOut', '>', d(todayIn(property.timezone)))
          .executeTakeFirstOrThrow()
      ).n,
    );
    if (upcoming) throw new ConflictError('INVALID_STATE_TRANSITION', `Property has ${upcoming} active or upcoming reservation(s)`);
    const updated = await this.db.updateTable('properties').set({ status: PropertyStatus.ARCHIVED }).where('id', '=', propertyId).returningAll().executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'property.archive', entityType: 'Property', entityId: propertyId, propertyId, before: { status: property.status }, after: { status: PropertyStatus.ARCHIVED } });
    return updated;
  }
}

function pick(o: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
}

