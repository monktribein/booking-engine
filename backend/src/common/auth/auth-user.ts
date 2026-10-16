import type { OrganizationStatus, PropertyUserRole, UserRole } from '../../database/enums';

/** The authenticated principal attached to `req.user` by JwtAuthGuard. Ids are uuid strings. */
export interface AuthUser {
  userId: string;
  organizationId: string | null;
  /** Null for platform staff, who belong to no organization. */
  organizationStatus: OrganizationStatus | null;
  role: UserRole;
  sessionId: string;
  email: string;
  name: string;
}

/** Attached to `req.propertyAccess` by PropertyAccessGuard once property membership is proven. */
export interface PropertyAccessContext {
  propertyId: string;
  /** Role on this property; SUPER_ADMIN for platform admins. */
  role: PropertyUserRole | 'SUPER_ADMIN';
}

/** Request metadata recorded in audit logs. */
export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}
