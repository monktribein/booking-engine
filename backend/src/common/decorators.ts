import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { UserRole } from '../database/enums';
import { clientIp } from './client-ip';
import type { AuthUser, PropertyAccessContext, RequestMeta } from './auth/auth-user';

export const IS_PUBLIC_KEY = 'tirvona:isPublic';
/** Opt a route out of JWT authentication (public booking engine, webhooks, login). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'tirvona:roles';
/** Restrict a route to organization-level roles (e.g. SUPER_ADMIN for /admin). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const REQUIRE_ACTIVE_ORG_KEY = 'tirvona:requireActiveOrg';
/** The organization must be ACTIVE (approved), not merely registered: API keys, webhooks, channels, marketplace. */
export const RequireActiveOrg = () => SetMetadata(REQUIRE_ACTIVE_ORG_KEY, true);

export const ALLOW_INACTIVE_ORG_KEY = 'tirvona:allowInactiveOrg';
/** Reachable even when the organization is suspended / rejected (so the UI can show why and let people sign out). */
export const AllowInactiveOrg = () => SetMetadata(ALLOW_INACTIVE_ORG_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
});

/** The property membership proven by PropertyAccessGuard for this request. */
export const PropertyCtx = createParamDecorator((_: unknown, ctx: ExecutionContext): PropertyAccessContext => {
  return ctx.switchToHttp().getRequest<Request & { propertyAccess: PropertyAccessContext }>().propertyAccess;
});

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: clientIp(req), userAgent: req.get('user-agent')?.slice(0, 300) };
});
