import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL } from '../constants';
import { baseSchemaOptions, objectId } from '../common/schema-helpers';

// ================================================================ auth_sessions

/**
 * One row per login (device). The refresh token itself is never stored, only
 * its SHA-256. Refresh rotates the token. Presenting an already-rotated token
 * means it was stolen and replayed, so the whole `familyId` is revoked.
 * Access JWTs carry the session id (`sid`) and are rejected once the session
 * is revoked (logout, password reset, reuse detection).
 */
export interface AuthSession {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: Types.ObjectId;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason?: string;
  rotatedAt: Date | null;
  ip?: string;
  userAgent?: string;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const AuthSessionSchema = new Schema<AuthSession>(
  {
    userId: objectId(MODEL.User),
    familyId: { type: Schema.Types.ObjectId, required: true },
    refreshTokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, maxlength: 100 },
    rotatedAt: { type: Date, default: null },
    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 300 },
    lastUsedAt: { type: Date, required: true },
  },
  baseSchemaOptions(COLLECTION.authSessions),
);

AuthSessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
AuthSessionSchema.index({ userId: 1, revokedAt: 1 });
AuthSessionSchema.index({ familyId: 1 });
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ================================================================ password_reset_tokens

export interface PasswordResetToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export const PasswordResetTokenSchema = new Schema<PasswordResetToken>(
  {
    userId: objectId(MODEL.User),
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  baseSchemaOptions(COLLECTION.passwordResetTokens, 'createdOnly'),
);

PasswordResetTokenSchema.index({ tokenHash: 1 }, { unique: true });
PasswordResetTokenSchema.index({ userId: 1 });
PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
