import { PropertyUserRole } from '../../database/enums';

/**
 * Property-level permissions. A user's role on a property (property_users.role)
 * grants a fixed set of them. Organization-level role (users.role) only
 * decides who may create properties and who is SUPER_ADMIN.
 */
export enum Permission {
  PROPERTY_VIEW = 'property:view',
  PROPERTY_EDIT = 'property:edit',
  PROPERTY_DELETE = 'property:delete',
  STAFF_MANAGE = 'staff:manage',
  ROOMS_MANAGE = 'rooms:manage',
  ROOM_STATUS = 'rooms:status',
  INVENTORY_VIEW = 'inventory:view',
  INVENTORY_MANAGE = 'inventory:manage',
  RATES_MANAGE = 'rates:manage',
  RESERVATIONS_VIEW = 'reservations:view',
  RESERVATIONS_MANAGE = 'reservations:manage',
  FRONT_DESK = 'reservations:front_desk',
  GUESTS_VIEW = 'guests:view',
  GUESTS_MANAGE = 'guests:manage',
  PAYMENTS_VIEW = 'payments:view',
  PAYMENTS_COLLECT = 'payments:collect',
  PAYMENTS_REFUND = 'payments:refund',
  CHANNELS_VIEW = 'channels:view',
  CHANNELS_MANAGE = 'channels:manage',
  REPORTS_VIEW = 'reports:view',
  AUDIT_VIEW = 'audit:view',
}

const ALL = Object.values(Permission);

const FRONT_OFFICE: Permission[] = [
  Permission.PROPERTY_VIEW,
  Permission.ROOM_STATUS,
  Permission.INVENTORY_VIEW,
  Permission.RESERVATIONS_VIEW,
  Permission.RESERVATIONS_MANAGE,
  Permission.FRONT_DESK,
  Permission.GUESTS_VIEW,
  Permission.GUESTS_MANAGE,
  Permission.PAYMENTS_VIEW,
];

export const ROLE_PERMISSIONS: Record<PropertyUserRole, ReadonlySet<Permission>> = {
  [PropertyUserRole.PROPERTY_OWNER]: new Set(ALL),
  [PropertyUserRole.PROPERTY_MANAGER]: new Set(ALL.filter((p) => p !== Permission.PROPERTY_DELETE)),
  [PropertyUserRole.RECEPTION]: new Set([...FRONT_OFFICE, Permission.PAYMENTS_COLLECT]),
  [PropertyUserRole.STAFF]: new Set(FRONT_OFFICE),
};

export function roleHasPermission(role: PropertyUserRole | 'SUPER_ADMIN', permission: Permission): boolean {
  return role === 'SUPER_ADMIN' || ROLE_PERMISSIONS[role].has(permission);
}
