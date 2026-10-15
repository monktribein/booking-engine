import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Connection, Types } from 'mongoose';
import { PropertyAccessService } from '../../common/access/property-access.service';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { Page, pageParams, slugify, toObjectId } from '../../common/utils';
import { todayIn } from '../../database/common/dates';
import { isDuplicateKeyError } from '../../database/common/schema-helpers';
import { runInTransaction } from '../../database/common/transaction';
import { ACTIVE_RESERVATION_STATUSES, PropertyStatus, PropertyUserRole, UserRole } from '../../database/enums';
import { ConflictError, DomainValidationError, ForbiddenError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { Property } from '../../database/schemas/property.schema';
import { AuditLogger } from '../audit/audit.logger';
import type { CreatePropertyDto, UpdatePropertyDto } from './dto/property.dto';

@Injectable()
export class PropertiesService {
  private readonly m: Models;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly access: PropertyAccessService,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  async list(user: AuthUser, page = 1, limit = 20): Promise<Page<Property>> {
    const ids = await this.access.accessiblePropertyIds(user);
    const filter = { status: { $ne: PropertyStatus.ARCHIVED }, ...(ids ? { _id: { $in: ids } } : {}) };
    const p = pageParams(page, limit);
    const [items, total] = await Promise.all([
      this.m.Property.find(filter).sort({ name: 1 }).skip(p.skip).limit(p.limit).lean(),
      this.m.Property.countDocuments(filter),
    ]);
    return { items, page: p.page, limit: p.limit, total };
  }

  async get(propertyId: Types.ObjectId): Promise<Property> {
    const p = await this.m.Property.findById(propertyId).lean();
    if (!p) throw new NotFoundError('Property', propertyId);
    return p;
  }

  /** Creates the property and makes the creator its PROPERTY_OWNER, atomically. */
  async create(user: AuthUser, meta: RequestMeta, dto: CreatePropertyDto): Promise<Property> {
    let organizationId: Types.ObjectId | null;
    if (user.role === UserRole.SUPER_ADMIN) {
      if (!dto.organizationId) throw new DomainValidationError('organizationId is required for SUPER_ADMIN');
      organizationId = toObjectId(dto.organizationId, 'organizationId');
    } else if (user.role === UserRole.PROPERTY_OWNER) {
      organizationId = user.organizationId;
    } else {
      throw new ForbiddenError('Only property owners can create properties');
    }
    const { organizationId: _ignored, ...fields } = dto;
    const slug = dto.slug ?? `${slugify(dto.name) || 'property'}-${randomBytes(2).toString('hex')}`;
    try {
      const property = await runInTransaction(this.connection, async (session) => {
        const [p] = await this.m.Property.create(
          [{ ...fields, slug, organizationId, ownerId: user.userId, status: dto.status ?? PropertyStatus.ACTIVE }],
          { session },
        );
        if (user.role !== UserRole.SUPER_ADMIN) {
          await this.m.PropertyUser.create([{ propertyId: p._id, userId: user.userId, role: PropertyUserRole.PROPERTY_OWNER }], { session });
        }
        await this.audit.log({ user, meta }, { action: 'property.create', entityType: 'Property', entityId: p._id, propertyId: p._id, organizationId, after: { name: p.name, slug } }, session);
        return p.toObject();
      });
      return property;
    } catch (err) {
      if (isDuplicateKeyError(err) && err.keyPattern?.slug) throw new ConflictError('SLUG_TAKEN', `The slug "${slug}" is already in use`);
      throw err;
    }
  }

  async update(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, dto: UpdatePropertyDto): Promise<Property> {
    const before = await this.get(propertyId);
    if (before.status === PropertyStatus.ARCHIVED) throw new DomainValidationError('Archived properties cannot be edited');
    try {
      const doc = await this.m.Property.findById(propertyId);
      doc!.set(dto);
      await doc!.save(); // save() runs the full schema validation, including cross-field hooks
      const after = doc!.toObject();
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
      if (isDuplicateKeyError(err)) throw new ConflictError('SLUG_TAKEN', 'This slug is already in use');
      throw err;
    }
  }

  /**
   * Soft delete: ARCHIVED. Refused while guests are booked for future nights,
   * because archiving would strand them. Cancel or move those bookings first.
   */
  async archive(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId): Promise<Property> {
    const property = await this.get(propertyId);
    const upcoming = await this.m.Reservation.countDocuments({
      propertyId,
      status: { $in: [...ACTIVE_RESERVATION_STATUSES] },
      checkOut: { $gt: todayIn(property.timezone) },
    });
    if (upcoming) throw new ConflictError('INVALID_STATE_TRANSITION', `Property has ${upcoming} active or upcoming reservation(s)`);
    const updated = await this.m.Property.findByIdAndUpdate(propertyId, { $set: { status: PropertyStatus.ARCHIVED } }, { new: true }).lean();
    await this.audit.log({ user, meta }, { action: 'property.archive', entityType: 'Property', entityId: propertyId, propertyId, before: { status: property.status }, after: { status: PropertyStatus.ARCHIVED } });
    return updated!;
  }
}

function pick(o: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
}
