import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { UserRole } from '../../database/enums';
import { ForbiddenError } from '../../database/errors';
import type { AuthUser } from '../auth/auth-user';
import { ROLES_KEY } from '../decorators';

/** Global guard enforcing @Roles(...) (organization-level roles). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenError('Your role does not allow this action');
    return true;
  }
}
