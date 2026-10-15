import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Types } from 'mongoose';
import { DomainValidationError, UnauthorizedError } from '../../database/errors';
import type { AuthUser, PropertyAccessContext } from '../auth/auth-user';
import { PROPERTY_ACCESS_KEY, PropertyAccessRule } from './property-access.decorator';
import { PropertyAccessService } from './property-access.service';

/**
 * Runs after JwtAuthGuard on routes marked with @PropertyAccess. It resolves
 * the property the request targets (directly, or through the entity id in the
 * URL/body/query), checks membership and permission, and stores the proof in
 * req.propertyAccess. Handlers then scope every query to that propertyId.
 */
@Injectable()
export class PropertyAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: PropertyAccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<PropertyAccessRule | undefined>(PROPERTY_ACCESS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!rule) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser; propertyAccess?: PropertyAccessContext }>();
    if (!req.user) throw new UnauthorizedError();

    const source = rule.in === 'param' ? req.params : rule.in === 'query' ? req.query : (req.body as Record<string, unknown>);
    const raw = source?.[rule.key];
    if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw) || String(new Types.ObjectId(raw)) !== raw.toLowerCase()) {
      throw new DomainValidationError(`${rule.key} must be a valid id`, { field: rule.key });
    }
    const propertyId = await this.access.resolvePropertyId(rule.entity, new Types.ObjectId(raw));
    req.propertyAccess = await this.access.assertAccess(req.user, propertyId, rule.permission);
    return true;
  }
}
