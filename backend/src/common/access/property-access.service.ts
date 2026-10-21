import { Injectable } from '@nestjs/common';
import { PropertyUserRole, UserRole } from '../../database/enums';
import { ForbiddenError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import type { AuthUser, PropertyAccessContext } from '../auth/auth-user';
import { Permission, roleHasPermission } from './permissions';
import type { ScopedEntity } from './property-access.decorator';

/** Table that owns each scoped entity (every one has a property_id column). */
const TABLE_OF = {
  roomType: 'roomTypes',
  room: 'rooms',
  reservation: 'reservations',
  guest: 'guests',
  payment: 'payments',
  inventoryBlock: 'inventoryBlocks',
  ratePlan: 'ratePlans',
  promotion: 'promotions',
  rateRule: 'rateRules',
} as const;

/**
 * The single place where "may this user touch this property?" is decided. Membership comes from property_users. The
 * frontend is never trusted.
 */
@Injectable()
export class PropertyAccessService {
  constructor(@InjectDb() private readonly db: Db) {}

  async resolvePropertyId(entity: ScopedEntity, id: string): Promise<string> {
    if (entity === 'property') {
      if (!(await this.db.selectFrom('properties').select('id').where('id', '=', id).executeTakeFirst())) throw new NotFoundError('Property', id);
      return id;
    }
    const table = TABLE_OF[entity];
    const row = await this.db.selectFrom(table).select('propertyId').where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError(entity, id);
    return row.propertyId;
  }

  async assertAccess(user: AuthUser, propertyId: string, permission: Permission): Promise<PropertyAccessContext> {
    if (user.role === UserRole.SUPER_ADMIN) return { propertyId, role: 'SUPER_ADMIN' };
    const membership = await this.db.selectFrom('propertyUsers').select('role').where('propertyId', '=', propertyId).where('userId', '=', user.userId).executeTakeFirst();
    if (!membership) throw new ForbiddenError('You do not have access to this property');
    const role = membership.role as PropertyUserRole;
    if (!roleHasPermission(role, permission)) {
      throw new ForbiddenError(`Your role (${role}) does not allow ${permission}`);
    }
    return { propertyId, role };
  }

  can(ctx: PropertyAccessContext, permission: Permission): boolean {
    return roleHasPermission(ctx.role, permission);
  }

  /** Property ids the user may list (null = all, for SUPER_ADMIN). */
  async accessiblePropertyIds(user: AuthUser): Promise<string[] | null> {
    if (user.role === UserRole.SUPER_ADMIN) return null;
    const rows = await this.db.selectFrom('propertyUsers').select('propertyId').where('userId', '=', user.userId).execute();
    return rows.map((r) => r.propertyId);
  }

  async roleOn(userId: string, propertyId: string): Promise<PropertyUserRole | null> {
    const m = await this.db.selectFrom('propertyUsers').select('role').where('propertyId', '=', propertyId).where('userId', '=', userId).executeTakeFirst();
    return (m?.role as PropertyUserRole | undefined) ?? null;
  }
}
