import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { createHmac, randomBytes } from 'node:crypto';
import { Connection, Types } from 'mongoose';
import type { AccessTokenClaims } from '../../common/guards/jwt-auth.guard';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { slugify } from '../../common/utils';
import type { AppConfig } from '../../config/configuration';
import { hashPassword, verifyPassword } from '../../database/common/crypto';
import { isDuplicateKeyError } from '../../database/common/schema-helpers';
import { runInTransaction } from '../../database/common/transaction';
import { UserRole, UserStatus } from '../../database/enums';
import { ConflictError, UnauthorizedError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { User } from '../../database/schemas/identity.schema';
import { AuditLogger } from '../audit/audit.logger';
import { PasswordResetService } from '../users/password-reset.service';
import { PublicUser, toPublicUser } from '../users/users.service';
import type { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
}

// A real scrypt hash of a random password: verifying against it costs the same
// as a real check, so response timing does not reveal whether an email exists.
let DUMMY_HASH: Promise<string> | null = null;

@Injectable()
export class AuthService {
  private readonly m: Models;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly resets: PasswordResetService,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  // ------------------------------------------------------------ register / login

  async register(dto: RegisterDto, meta: RequestMeta): Promise<IssuedTokens> {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await hashPassword(dto.password);
    let user: User;
    try {
      user = await runInTransaction(this.connection, async (session) => {
        const slug = `${slugify(dto.organizationName) || 'org'}-${randomBytes(3).toString('hex')}`;
        const [org] = await this.m.Organization.create([{ name: dto.organizationName, slug }], { session });
        const [u] = await this.m.User.create(
          [{ organizationId: org._id, name: dto.name, email, phone: dto.phone, passwordHash, role: UserRole.PROPERTY_OWNER, status: UserStatus.ACTIVE }],
          { session },
        );
        return u.toObject();
      });
    } catch (err) {
      if (isDuplicateKeyError(err) && err.keyPattern?.email) throw new ConflictError('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
    this.audit.logSafe({ meta }, { action: 'auth.register', entityType: 'User', entityId: user._id, userId: user._id, organizationId: user.organizationId });
    return this.startSession(user, meta);
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<IssuedTokens> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.m.User.findOne({ email }).select('+passwordHash').lean();
    const ok = await verifyPassword(dto.password, user?.passwordHash ?? (await this.dummyHash()));
    if (!user || !ok) {
      this.audit.logSafe({ meta }, {
        action: 'auth.login_failed',
        entityType: 'User',
        entityId: user?._id ?? new Types.ObjectId('000000000000000000000000'),
        userId: user?._id ?? null,
        metadata: { reason: user ? 'bad_password' : 'unknown_email' },
      });
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.status !== UserStatus.ACTIVE) throw new UnauthorizedError('This account is not active', 'ACCOUNT_INACTIVE');
    await this.m.User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    this.audit.logSafe({ meta }, { action: 'auth.login', entityType: 'User', entityId: user._id, userId: user._id, organizationId: user.organizationId });
    return this.startSession(user, meta);
  }

  // ------------------------------------------------------------ refresh / logout

  /**
   * Rotates the refresh token. Each refresh creates a new session row in the
   * same family and marks the old one rotated. Presenting a rotated token again
   * means it leaked, so the whole family is revoked and the caller must log in.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedTokens> {
    const hash = this.hashRefresh(refreshToken);
    const now = new Date();
    const current = await this.m.AuthSession.findOne({ refreshTokenHash: hash }).lean();
    if (!current || current.expiresAt <= now) throw new UnauthorizedError('Refresh token is invalid or expired', 'TOKEN_INVALID');
    const reuse = async () => {
      await this.m.AuthSession.updateMany({ familyId: current.familyId, revokedAt: null }, { $set: { revokedAt: now, revokedReason: 'refresh_token_reuse' } });
      this.audit.logSafe({ meta }, { action: 'auth.refresh_reuse_detected', entityType: 'User', entityId: current.userId, userId: current.userId });
      return new UnauthorizedError('Refresh token was already used; all sessions of this login were revoked', 'TOKEN_REUSED');
    };
    if (current.rotatedAt) throw await reuse();
    if (current.revokedAt) throw new UnauthorizedError('Refresh token is invalid or expired', 'TOKEN_INVALID');
    // Conditional claim: of two concurrent refreshes with the same token, only one wins.
    const claimed = await this.m.AuthSession.findOneAndUpdate(
      { _id: current._id, rotatedAt: null, revokedAt: null },
      { $set: { rotatedAt: now, lastUsedAt: now } },
      { new: true },
    ).lean();
    if (!claimed) throw await reuse();
    const user = await this.m.User.findById(current.userId).lean();
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthorizedError('This account is not active', 'ACCOUNT_INACTIVE');
    // The old row stays (rotated) for reuse detection until it expires; it can no longer authorize requests.
    await this.m.AuthSession.updateOne({ _id: current._id }, { $set: { revokedAt: now, revokedReason: 'rotated' } });
    return this.startSession(user, meta, current.familyId);
  }

  async logout(user: AuthUser, meta: RequestMeta): Promise<void> {
    const s = await this.m.AuthSession.findById(user.sessionId, { familyId: 1 }).lean();
    if (s) await this.m.AuthSession.updateMany({ familyId: s.familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'logout' } });
    this.audit.logSafe({ user, meta }, { action: 'auth.logout', entityType: 'User', entityId: user.userId });
  }

  // ------------------------------------------------------------ password reset

  /** Always succeeds from the caller's view, so it cannot be used to discover accounts. */
  async forgotPassword(dto: ForgotPasswordDto, meta: RequestMeta): Promise<void> {
    const user = await this.m.User.findOne({ email: dto.email.trim().toLowerCase() }, { email: 1, name: 1, status: 1 }).lean();
    if (!user || ![UserStatus.ACTIVE, UserStatus.INVITED].includes(user.status)) return;
    await this.resets.issue(user, 'RESET');
    this.audit.logSafe({ meta }, { action: 'auth.password_reset_requested', entityType: 'User', entityId: user._id, userId: user._id });
  }

  async resetPassword(dto: ResetPasswordDto, meta: RequestMeta): Promise<void> {
    const userId = await this.resets.consume(dto.token);
    if (!userId) throw new UnauthorizedError('Reset link is invalid or has expired', 'TOKEN_INVALID');
    const passwordHash = await hashPassword(dto.newPassword);
    const now = new Date();
    await runInTransaction(this.connection, async (session) => {
      // Invited users become ACTIVE by choosing a password; suspended accounts stay suspended.
      await this.m.User.updateOne(
        { _id: userId },
        [{ $set: { passwordHash, status: { $cond: [{ $eq: ['$status', UserStatus.INVITED] }, UserStatus.ACTIVE, '$status'] }, updatedAt: now } }],
        { session, timestamps: false },
      );
      await this.m.AuthSession.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now, revokedReason: 'password_reset' } }, { session });
    });
    this.audit.logSafe({ meta }, { action: 'auth.password_reset', entityType: 'User', entityId: userId, userId });
  }

  // ------------------------------------------------------------ internals

  private async startSession(user: User, meta: RequestMeta, familyId?: Types.ObjectId): Promise<IssuedTokens> {
    const jwtCfg = this.config.get('jwt', { infer: true });
    const refreshToken = randomBytes(48).toString('base64url');
    const now = new Date();
    const session = await this.m.AuthSession.create({
      userId: user._id,
      familyId: familyId ?? new Types.ObjectId(),
      refreshTokenHash: this.hashRefresh(refreshToken),
      expiresAt: new Date(now.getTime() + jwtCfg.refreshTtlDays * 86_400_000),
      ip: meta.ip,
      userAgent: meta.userAgent,
      lastUsedAt: now,
    });
    const claims: AccessTokenClaims = { sub: String(user._id), sid: String(session._id), org: user.organizationId ? String(user.organizationId) : null, role: user.role };
    const accessToken = await this.jwt.signAsync(claims);
    return { accessToken, refreshToken, expiresIn: jwtCfg.accessTtlSeconds, user: toPublicUser(user) };
  }

  /** Keyed hash: a leaked database alone cannot be used to forge or verify refresh tokens. */
  private hashRefresh(token: string): string {
    return createHmac('sha256', this.config.get('jwt', { infer: true }).refreshSecret).update(token).digest('hex');
  }

  private dummyHash(): Promise<string> {
    DUMMY_HASH ??= hashPassword(randomBytes(16).toString('hex'));
    return DUMMY_HASH;
  }
}
