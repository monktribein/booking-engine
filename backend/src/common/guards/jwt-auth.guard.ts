import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { OrganizationStatus, UserStatus } from '../../database/enums';
import { ForbiddenError, UnauthorizedError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import type { AuthUser } from '../auth/auth-user';
import { isUuid } from '../utils';
import { ALLOW_INACTIVE_ORG_KEY, IS_PUBLIC_KEY, REQUIRE_ACTIVE_ORG_KEY } from '../decorators';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  org: string | null;
  role: string;
}

/**
 * Global guard. It verifies the Bearer access token (signature, expiry,
 * issuer, audience), then checks that the session behind it is still live
 * and the user still active. Logout, password reset and refresh-token reuse
 * therefore take effect immediately, not when the JWT expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectDb() private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedError('Missing bearer token');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch {
      throw new UnauthorizedError('Invalid or expired access token', 'TOKEN_INVALID');
    }
    if (!isUuid(claims.sid) || !isUuid(claims.sub)) {
      throw new UnauthorizedError('Invalid access token', 'TOKEN_INVALID');
    }

    const [session, user] = await Promise.all([
      this.db.selectFrom('authSessions').select('id').where('id', '=', claims.sid).where('userId', '=', claims.sub).where('revokedAt', 'is', null).where('expiresAt', '>', new Date()).executeTakeFirst(),
      this.db
        .selectFrom('users')
        .leftJoin('organizations', 'organizations.id', 'users.organizationId')
        .select(['users.id', 'users.organizationId', 'users.role', 'users.status', 'users.email', 'users.name', 'organizations.status as organizationStatus'])
        .where('users.id', '=', claims.sub)
        .executeTakeFirst(),
    ]);
    if (!session) throw new UnauthorizedError('Session has ended', 'SESSION_REVOKED');
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthorizedError('Account is not active', 'ACCOUNT_INACTIVE');

    const orgStatus = (user.organizationStatus ?? null) as OrganizationStatus | null;
    const at = [ctx.getHandler(), ctx.getClass()];
    if (orgStatus && !this.reflector.getAllAndOverride<boolean>(ALLOW_INACTIVE_ORG_KEY, at)) {
      // A suspended, rejected or archived partner is locked out of everything except reading its own status and signing out.
      if (orgStatus !== OrganizationStatus.ACTIVE && orgStatus !== OrganizationStatus.PENDING_APPROVAL) {
        throw new ForbiddenError(`This organization is ${orgStatus.toLowerCase().replace('_', ' ')}. Contact Tirvona support.`, 'ORGANIZATION_DISABLED');
      }
      if (orgStatus !== OrganizationStatus.ACTIVE && this.reflector.getAllAndOverride<boolean>(REQUIRE_ACTIVE_ORG_KEY, at)) {
        throw new ForbiddenError('This feature is available after the platform approves your organization.', 'ORGANIZATION_NOT_APPROVED');
      }
    }

    req.user = {
      userId: user.id,
      organizationId: user.organizationId,
      organizationStatus: orgStatus,
      role: user.role as AuthUser['role'], // read fresh from the DB, so demotions apply at once
      sessionId: session.id,
      email: user.email,
      name: user.name,
    };
    return true;
  }
}
