import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { hashPassword } from '../../database/common/crypto';
import type { User } from '../../database/db-types';
import { PropertyUserRole, UserStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, isUniqueViolation, runInTransaction } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';
import type { AddStaffDto, UpdateMeDto } from './dto/user.dto';
import { PasswordResetService } from './password-reset.service';

export type PublicUser = Omit<User, 'passwordHash'>;

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
    const u = await this.db.selectFrom('users').select(PUBLIC_USER_COLUMNS).where('id', '=', userId).executeTakeFirst();
    if (!u) throw new NotFoundError('User', userId);
    return u;
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
