import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { hashPassword } from '../../database/common/crypto';
import type { User } from '../../database/db-types';
import type { OrganizationStatus } from '../../database/enums';
import { PropertyUserRole, UserRole, UserStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, isUniqueViolation, runInTransaction } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';
import type { AddStaffDto, InviteDeveloperDto, UpdateMeDto } from './dto/user.dto';
import { PasswordResetService } from './password-reset.service';

/** The signed-in user as the API returns it: never the password hash, plus the partner's approval state for the UI banner. */
export type PublicUser = Omit<User, 'passwordHash'> & { organizationStatus?: OrganizationStatus | null };

export function toPublicUser(u: User | PublicUser): PublicUser {
  const { passwordHash: _omit, ...rest } = u as User;
  return rest;
}

/** Every user column except the password hash. */
export const PUBLIC_USER_COLUMNS = ['id', 'organizationId', 'name', 'email', 'phone', 'role', 'status', 'lastLoginAt', 'createdAt', 'updatedAt'] as const;

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly resets: PasswordResetService,
    private readonly audit: AuditLogger,
  ) {}

  async me(userId: string): Promise<PublicUser> {
    const u = await this.db
      .selectFrom('users')
      .leftJoin('organizations', 'organizations.id', 'users.organizationId')
      .select([
        'users.id',
        'users.organizationId',
        'users.name',
        'users.email',
        'users.phone',
        'users.role',
        'users.status',
        'users.lastLoginAt',
        'users.createdAt',
        'users.updatedAt',
        'organizations.status as organizationStatus',
      ])
      .where('users.id', '=', userId)
      .executeTakeFirst();
    if (!u) throw new NotFoundError('User', userId);
    return u as PublicUser;
  }

  async updateMe(user: AuthUser, dto: UpdateMeDto): Promise<PublicUser> {
    const set: { name?: string; phone?: string } = {};
    if (dto.name !== undefined) set.name = dto.name.trim();
    if (dto.phone !== undefined) set.phone = dto.phone;
    if (Object.keys(set).length) await this.db.updateTable('users').set(set).where('id', '=', user.userId).execute();
    return this.me(user.userId);
  }

  async listStaff(propertyId: string) {
    return this.db
      .selectFrom('propertyUsers as pu')
      .innerJoin('users as u', 'u.id', 'pu.userId')
      .select(['pu.userId', 'u.name', 'u.email', 'u.status', 'pu.role'])
      .where('pu.propertyId', '=', propertyId)
      .orderBy('u.name')
      .execute();
  }

  /**
   * Adds a staff member to a property. Existing users of the same organization are linked. New users are created as
   * INVITED (no usable password) and receive a set-password link.
   */
  async addStaff(actor: AuthUser, meta: RequestMeta, propertyId: string, dto: AddStaffDto) {
    const property = await this.db.selectFrom('properties').select('organizationId').where('id', '=', propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', propertyId);
    const email = dto.email.trim().toLowerCase();
    let user = await this.db.selectFrom('users').select(PUBLIC_USER_COLUMNS).where('email', '=', email).executeTakeFirst();
    if (user && user.organizationId && user.organizationId !== property.organizationId) {
      throw new ConflictError('EMAIL_TAKEN', 'This email belongs to another organization');
    }
    if (!user) {
      // Random unusable password until the invitee sets one via the link.
      const passwordHash = await hashPassword(randomBytes(24).toString('base64url'));
      try {
        user = await this.db
          .insertInto('users')
          .values({ organizationId: property.organizationId, name: dto.name, email, phone: dto.phone ?? null, passwordHash, role: dto.role, status: UserStatus.INVITED, lastLoginAt: null })
          .returning(PUBLIC_USER_COLUMNS)
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError('EMAIL_TAKEN', 'This email is already registered');
        throw err;
      }
      await this.resets.issue(user, 'INVITE', propertyId);
    }
    try {
      await this.db.insertInto('propertyUsers').values({ propertyId, userId: user.id, role: dto.role }).execute();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE', 'User already has access to this property');
      throw err;
    }
    await this.audit.log({ user: actor, meta }, { action: 'property.staff_add', entityType: 'Property', entityId: propertyId, propertyId, after: { userId: user.id, role: dto.role } });
    return { userId: user.id, name: user.name, email: user.email, status: user.status, role: dto.role };
  }

  /** Everyone in the caller's organization. Never returns the password hash. */
  async listMembers(actor: AuthUser) {
    if (!actor.organizationId) return [];
    return this.db
      .selectFrom('users')
      .select(['id', 'name', 'email', 'role', 'status', 'lastLoginAt'])
      .where('organizationId', '=', actor.organizationId)
      .orderBy('role')
      .orderBy('name')
      .execute();
  }

  /** A developer belongs to the organization, not to a property: API keys and webhooks only. */
  async inviteDeveloper(actor: AuthUser, meta: RequestMeta, dto: InviteDeveloperDto) {
    if (!actor.organizationId) throw new DomainValidationError('This account has no organization');
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await hashPassword(randomBytes(24).toString('base64url'));
    let user;
    try {
      user = await this.db
        .insertInto('users')
        .values({ organizationId: actor.organizationId, name: dto.name.trim(), email, phone: null, passwordHash, role: UserRole.DEVELOPER, status: UserStatus.INVITED, lastLoginAt: null })
        .returning(['id', 'name', 'email', 'role', 'status', 'lastLoginAt'])
        .executeTakeFirstOrThrow();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('EMAIL_TAKEN', 'This email is already registered');
      throw err;
    }
    await this.resets.issue(user, 'INVITE');
    await this.audit.log({ user: actor, meta }, { action: 'organization.developer_invite', entityType: 'User', entityId: user.id, after: { role: UserRole.DEVELOPER } });
    return user;
  }

  async removeDeveloper(actor: AuthUser, meta: RequestMeta, userId: string) {
    const res = await this.db
      .updateTable('users')
      .set({ status: UserStatus.DISABLED })
      .where('id', '=', userId)
      .where('organizationId', '=', actor.organizationId ?? '00000000-0000-0000-0000-000000000000')
      .where('role', '=', UserRole.DEVELOPER)
      .returning('id')
      .executeTakeFirst();
    if (!res) throw new NotFoundError('Developer', userId);
    await this.db.updateTable('authSessions').set({ revokedAt: new Date(), revokedReason: 'access_removed' }).where('userId', '=', userId).where('revokedAt', 'is', null).execute();
    await this.audit.log({ user: actor, meta }, { action: 'organization.developer_remove', entityType: 'User', entityId: userId });
    return { ok: true };
  }

  async removeStaff(actor: AuthUser, meta: RequestMeta, propertyId: string, userId: string) {
    const row = await runInTransaction(this.db, async (tx) => {
      const found = await tx.selectFrom('propertyUsers').selectAll().where('propertyId', '=', propertyId).where('userId', '=', userId).forUpdate().executeTakeFirst();
      if (!found) throw new NotFoundError('Property staff member', userId);
      if (found.role === PropertyUserRole.PROPERTY_OWNER) {
        const owners = await tx.selectFrom('propertyUsers').select((eb) => eb.fn.countAll<number>().as('n')).where('propertyId', '=', propertyId).where('role', '=', PropertyUserRole.PROPERTY_OWNER).executeTakeFirstOrThrow();
        if (Number(owners.n) <= 1) throw new DomainValidationError('A property must keep at least one owner');
      }
      await tx.deleteFrom('propertyUsers').where('id', '=', found.id).execute();
      return found;
    });
    await this.audit.log({ user: actor, meta }, { action: 'property.staff_remove', entityType: 'Property', entityId: propertyId, propertyId, before: { userId, role: row.role } });
    return { ok: true };
  }
}
