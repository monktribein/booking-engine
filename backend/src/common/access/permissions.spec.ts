import { PropertyUserRole } from '../../database/enums';
import { Permission, roleHasPermission } from './permissions';

describe('RBAC permission matrix', () => {
  it('owners can do everything, managers everything but deleting the property', () => {
    for (const p of Object.values(Permission)) expect(roleHasPermission(PropertyUserRole.PROPERTY_OWNER, p)).toBe(true);
    expect(roleHasPermission(PropertyUserRole.PROPERTY_MANAGER, Permission.PROPERTY_DELETE)).toBe(false);
    expect(roleHasPermission(PropertyUserRole.PROPERTY_MANAGER, Permission.CHANNELS_MANAGE)).toBe(true);
  });

  it.each([
    [PropertyUserRole.RECEPTION, Permission.FRONT_DESK, true],
    [PropertyUserRole.RECEPTION, Permission.RESERVATIONS_MANAGE, true],
    [PropertyUserRole.RECEPTION, Permission.PAYMENTS_COLLECT, true],
    [PropertyUserRole.RECEPTION, Permission.PAYMENTS_REFUND, false],
    [PropertyUserRole.RECEPTION, Permission.ROOMS_MANAGE, false],
    [PropertyUserRole.RECEPTION, Permission.RATES_MANAGE, false],
    [PropertyUserRole.RECEPTION, Permission.CHANNELS_MANAGE, false],
    [PropertyUserRole.RECEPTION, Permission.STAFF_MANAGE, false],
    [PropertyUserRole.STAFF, Permission.PAYMENTS_COLLECT, false],
    [PropertyUserRole.STAFF, Permission.ROOM_STATUS, true],
    [PropertyUserRole.STAFF, Permission.AUDIT_VIEW, false],
  ])('%s → %s = %s', (role, permission, allowed) => {
    expect(roleHasPermission(role, permission)).toBe(allowed);
  });

  it('SUPER_ADMIN passes every permission check', () => {
    for (const p of Object.values(Permission)) expect(roleHasPermission('SUPER_ADMIN', p)).toBe(true);
  });
});
