import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { UserRole } from '../database/enums';
import type { AuthUser, PropertyAccessContext, RequestMeta } from './auth/auth-user';

export const IS_PUBLIC_KEY = 'tirvona:isPublic';
/** Opt a route out of JWT authentication (public booking engine, webhooks, login). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'tirvona:roles';
/** Restrict a route to organization-level roles (e.g. SUPER_ADMIN for /admin). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
});

/** The property membership proven by PropertyAccessGuard for this request. */
export const PropertyCtx = createParamDecorator((_: unknown, ctx: ExecutionContext): PropertyAccessContext => {
  return ctx.switchToHttp().getRequest<Request & { propertyAccess: PropertyAccessContext }>().propertyAccess;
});

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) };
});
