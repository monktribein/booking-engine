import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Connection, Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { hashPassword } from '../../database/common/crypto';
import { isDuplicateKeyError } from '../../database/common/schema-helpers';
import { PropertyUserRole, UserStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { User } from '../../database/schemas/identity.schema';
import { AuditLogger } from '../audit/audit.logger';
import type { AddStaffDto, UpdateMeDto } from './dto/user.dto';
import { PasswordResetService } from './password-reset.service';

export type PublicUser = Omit<User, 'passwordHash'>;

export function toPublicUser(u: User | PublicUser): PublicUser {
  const { passwordHash: _omit, ...rest } = u as User;
  return rest;
}

@Injectable()
export class UsersService {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly resets: PasswordResetService,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  async me(userId: Types.ObjectId): Promise<PublicUser> {
    const u = await this.m.User.findById(userId).lean();
    if (!u) throw new NotFoundError('User', userId);
    return toPublicUser(u);
  }

  async updateMe(user: AuthUser, dto: UpdateMeDto): Promise<PublicUser> {
    const u = await this.m.User.findByIdAndUpdate(user.userId, { $set: dto }, { new: true, runValidators: true }).lean();
    return toPublicUser(u!);
  }

  async listStaff(propertyId: Types.ObjectId) {
    const rows = await this.m.PropertyUser.find({ propertyId }).lean();
    const users = await this.m.User.find({ _id: { $in: rows.map((r) => r.userId) } }, { name: 1, email: 1, status: 1 }).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return rows.map((r) => {
      const u = byId.get(String(r.userId));
      return { userId: r.userId, name: u?.name, email: u?.email, status: u?.status, role: r.role };
    });
  }

  /**
   * Adds a staff member to a property. Existing users of the same organization
   * are linked. New users are created as INVITED (no usable password) and
   * receive a set-password link.
   */
  async addStaff(actor: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, dto: AddStaffDto) {
    const property = await this.m.Property.findById(propertyId, { organizationId: 1 }).lean();
    if (!property) throw new NotFoundError('Property', propertyId);
    const email = dto.email.trim().toLowerCase();
    let user = await this.m.User.findOne({ email }).lean();
    if (user && user.organizationId && !user.organizationId.equals(property.organizationId)) {
      throw new ConflictError('EMAIL_TAKEN', 'This email belongs to another organization');
    }
    if (!user) {
      const [created] = await this.m.User.create([
        {
          organizationId: property.organizationId,
          name: dto.name,
          email,
          phone: dto.phone,
          // Random unusable password until the invitee sets one via the link.
          passwordHash: await hashPassword(randomBytes(24).toString('base64url')),
          role: dto.role,
          status: UserStatus.INVITED,
        },
      ]);
      user = created.toObject();
      await this.resets.issue(user, 'INVITE', propertyId);
    }
    try {
      await this.m.PropertyUser.create({ propertyId, userId: user._id, role: dto.role });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('DUPLICATE', 'User already has access to this property');
      throw err;
    }
    await this.audit.log({ user: actor, meta }, {
      action: 'property.staff_add',
      entityType: 'Property',
      entityId: propertyId,
      propertyId,
      after: { userId: user._id, role: dto.role },
    });
    return { userId: user._id, name: user.name, email: user.email, status: user.status, role: dto.role };
  }

  async removeStaff(actor: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, userId: Types.ObjectId) {
    const row = await this.m.PropertyUser.findOne({ propertyId, userId }).lean();
    if (!row) throw new NotFoundError('Property staff member', userId);
    if (row.role === PropertyUserRole.PROPERTY_OWNER) {
      const owners = await this.m.PropertyUser.countDocuments({ propertyId, role: PropertyUserRole.PROPERTY_OWNER });
      if (owners <= 1) throw new DomainValidationError('A property must keep at least one owner');
    }
    await this.m.PropertyUser.deleteOne({ _id: row._id });
    await this.audit.log({ user: actor, meta }, {
      action: 'property.staff_remove',
      entityType: 'Property',
      entityId: propertyId,
      propertyId,
      before: { userId, role: row.role },
    });
    return { ok: true };
  }
}
