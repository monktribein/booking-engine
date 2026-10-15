import type { Types } from 'mongoose';
import type { PropertyUserRole, UserRole } from '../../database/enums';

/** The authenticated principal attached to `req.user` by JwtAuthGuard. */
export interface AuthUser {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId | null;
  role: UserRole;
  sessionId: Types.ObjectId;
  email: string;
  name: string;
}

/** Attached to `req.propertyAccess` by PropertyAccessGuard once property membership is proven. */
export interface PropertyAccessContext {
  propertyId: Types.ObjectId;
  /** Role on this property; SUPER_ADMIN for platform admins. */
  role: PropertyUserRole | 'SUPER_ADMIN';
}

/** Request metadata recorded in audit logs. */
export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}
