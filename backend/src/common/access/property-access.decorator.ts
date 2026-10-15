import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

/** Entities whose `propertyId` the guard can resolve from an id in the request. */
export type ScopedEntity =
  | 'property'
  | 'roomType'
  | 'room'
  | 'reservation'
  | 'guest'
  | 'payment'
  | 'inventoryBlock'
  | 'ratePlan'
  | 'promotion';

export interface PropertyAccessRule {
  permission: Permission;
  /** Where the id lives in the request. */
  in: 'param' | 'query' | 'body';
  key: string;
  /** What the id refers to. 'property' means the value is itself the propertyId. */
  entity: ScopedEntity;
}

export const PROPERTY_ACCESS_KEY = 'tirvona:propertyAccess';

/**
 * Declares that a route touches exactly one property's data and which
 * permission it needs. PropertyAccessGuard resolves the property from the
 * request and proves membership before the handler runs.
 *
 *   @PropertyAccess(Permission.RESERVATIONS_VIEW, { in: 'param', key: 'id', entity: 'reservation' })
 */
export const PropertyAccess = (permission: Permission, where: Omit<PropertyAccessRule, 'permission'>) =>
  SetMetadata(PROPERTY_ACCESS_KEY, { permission, ...where } satisfies PropertyAccessRule);
