import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { PropertyUserRole, UserRole } from '../../database/enums';
import { ForbiddenError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { AuthUser, PropertyAccessContext } from '../auth/auth-user';
import { Permission, roleHasPermission } from './permissions';
import type { ScopedEntity } from './property-access.decorator';

/**
 * The single place where "may this user touch this property?" is decided.
 * Membership comes from property_users. The frontend is never trusted.
 */
@Injectable()
export class PropertyAccessService {
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

  async resolvePropertyId(entity: ScopedEntity, id: Types.ObjectId): Promise<Types.ObjectId> {
    if (entity === 'property') {
      if (!(await this.m.Property.exists({ _id: id }))) throw new NotFoundError('Property', id);
      return id;
    }
    const model = {
      roomType: this.m.RoomType,
      room: this.m.Room,
      reservation: this.m.Reservation,
      guest: this.m.Guest,
      payment: this.m.Payment,
      inventoryBlock: this.m.InventoryBlock,
      ratePlan: this.m.RatePlan,
      promotion: this.m.Promotion,
    }[entity] as unknown as { findById(id: unknown, p: object): { lean(): Promise<{ propertyId: Types.ObjectId } | null> } };
    const doc = await model.findById(id, { propertyId: 1 }).lean();
    if (!doc) throw new NotFoundError(entity, id);
    return doc.propertyId;
  }

  async assertAccess(user: AuthUser, propertyId: Types.ObjectId, permission: Permission): Promise<PropertyAccessContext> {
    if (user.role === UserRole.SUPER_ADMIN) return { propertyId, role: 'SUPER_ADMIN' };
    const membership = await this.m.PropertyUser.findOne({ propertyId, userId: user.userId }, { role: 1 }).lean();
    if (!membership) throw new ForbiddenError('You do not have access to this property');
    if (!roleHasPermission(membership.role, permission)) {
      throw new ForbiddenError(`Your role (${membership.role}) does not allow ${permission}`);
    }
    return { propertyId, role: membership.role };
  }

  can(ctx: PropertyAccessContext, permission: Permission): boolean {
    return roleHasPermission(ctx.role, permission);
  }

  /** Property ids the user may list (null = all, for SUPER_ADMIN). */
  async accessiblePropertyIds(user: AuthUser): Promise<Types.ObjectId[] | null> {
    if (user.role === UserRole.SUPER_ADMIN) return null;
    const rows = await this.m.PropertyUser.find({ userId: user.userId }, { propertyId: 1 }).lean();
    return rows.map((r) => r.propertyId);
  }

  async roleOn(userId: Types.ObjectId, propertyId: Types.ObjectId): Promise<PropertyUserRole | null> {
    const m = await this.m.PropertyUser.findOne({ propertyId, userId }, { role: 1 }).lean();
    return m?.role ?? null;
  }
}
