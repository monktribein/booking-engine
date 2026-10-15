import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL } from '../constants';
import { PASSWORD_HASH_RE } from '../common/crypto';
import { baseSchemaOptions, email, enumOf, objectId, phone, slug } from '../common/schema-helpers';
import {
  OrganizationStatus,
  PropertyUserRole,
  UserRole,
  UserStatus,
} from '../enums';

// ================================================================ organizations

export interface Organization {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const OrganizationSchema = new Schema<Organization>(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: slug(),
    status: enumOf(OrganizationStatus, true, OrganizationStatus.ACTIVE),
  },
  baseSchemaOptions(COLLECTION.organizations),
);

OrganizationSchema.index({ slug: 1 }, { unique: true });

// ================================================================ users

export interface User {
  _id: Types.ObjectId;
  /** Null only for SUPER_ADMIN (platform staff). */
  organizationId: Types.ObjectId | null;
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  /** Organization-level role. Per-property permissions live in property_users. */
  role: UserRole;
  status: UserStatus;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const UserSchema = new Schema<User>(
  {
    organizationId: objectId(MODEL.Organization, false),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: email(true),
    phone: phone(),
    // select:false keeps the hash out of every query unless explicitly asked for with .select('+passwordHash').
    passwordHash: {
      type: String,
      required: true,
      select: false,
      match: [PASSWORD_HASH_RE, 'passwordHash must be a scrypt/bcrypt/argon2 hash, never a plaintext password'] as [RegExp, string],
    },
    role: enumOf(UserRole),
    status: enumOf(UserStatus, true, UserStatus.INVITED),
    lastLoginAt: { type: Date },
  },
  {
    ...baseSchemaOptions(COLLECTION.users),
    toJSON: {
      versionKey: false,
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

UserSchema.pre('validate', function () {
  if (this.role !== UserRole.SUPER_ADMIN && !this.organizationId) {
    this.invalidate('organizationId', 'organizationId is required for every role except SUPER_ADMIN');
  }
});

// Login is by email across the whole platform.
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ organizationId: 1, role: 1 });

// ================================================================ property_users

export interface PropertyUser {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  userId: Types.ObjectId;
  role: PropertyUserRole;
  createdAt: Date;
  updatedAt: Date;
}

export const PropertyUserSchema = new Schema<PropertyUser>(
  {
    propertyId: objectId(MODEL.Property),
    userId: objectId(MODEL.User),
    role: enumOf(PropertyUserRole),
  },
  baseSchemaOptions(COLLECTION.propertyUsers),
);

// Unique pair; the propertyId prefix also serves "staff of this property".
PropertyUserSchema.index({ propertyId: 1, userId: 1 }, { unique: true });
// "Which properties can this user access?", run on every authenticated request.
PropertyUserSchema.index({ userId: 1, propertyId: 1 });
