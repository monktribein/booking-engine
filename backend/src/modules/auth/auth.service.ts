import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { sql } from 'kysely';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AccessTokenClaims } from '../../common/guards/jwt-auth.guard';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { slugify } from '../../common/utils';
import type { AppConfig } from '../../config/configuration';
import { hashPassword, verifyPassword } from '../../database/common/crypto';
import type { User } from '../../database/db-types';
import { UserRole, UserStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, UnauthorizedError } from '../../database/errors';
import { Db, InjectDb, isUniqueViolation, runInTransaction } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';
import { PasswordResetService } from '../users/password-reset.service';
import { PublicUser, toPublicUser } from '../users/users.service';
import type { ChangePasswordDto, ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
}

/** Used when a login names an unknown account: the audit row still needs an entity id. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// A real scrypt hash of a random password: verifying against it costs the same as a real check, so response timing
// does not reveal whether an email exists.
let DUMMY_HASH: Promise<string> | null = null;

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly resets: PasswordResetService,
    private readonly audit: AuditLogger,
  ) {}

  // ------------------------------------------------------------ register / login

  async register(dto: RegisterDto, meta: RequestMeta): Promise<IssuedTokens> {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await hashPassword(dto.password);
    let user: User;
    try {
      user = await runInTransaction(this.db, async (tx) => {
        const slug = `${slugify(dto.organizationName) || 'org'}-${randomBytes(3).toString('hex')}`;
        const org = await tx.insertInto('organizations').values({ name: dto.organizationName, slug }).returning('id').executeTakeFirstOrThrow();
        return tx
          .insertInto('users')
          .values({ organizationId: org.id, name: dto.name, email, phone: dto.phone ?? null, passwordHash, role: UserRole.PROPERTY_OWNER, status: UserStatus.ACTIVE, lastLoginAt: null })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) throw new ConflictError('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
    this.audit.logSafe({ meta }, { action: 'auth.register', entityType: 'User', entityId: user.id, userId: user.id, organizationId: user.organizationId });
    return this.startSession(user, meta);
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<IssuedTokens> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
    const ok = await verifyPassword(dto.password, user?.passwordHash ?? (await this.dummyHash()));
    if (!user || !ok) {
      this.audit.logSafe({ meta }, {
        action: 'auth.login_failed',
        entityType: 'User',
        entityId: user?.id ?? NIL_UUID,
        userId: user?.id ?? null,
        metadata: { reason: user ? 'bad_password' : 'unknown_email' },
      });
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.status !== UserStatus.ACTIVE) throw new UnauthorizedError('This account is not active', 'ACCOUNT_INACTIVE');
    await this.db.updateTable('users').set({ lastLoginAt: new Date() }).where('id', '=', user.id).execute();
    this.audit.logSafe({ meta }, { action: 'auth.login', entityType: 'User', entityId: user.id, userId: user.id, organizationId: user.organizationId });
    return this.startSession(user, meta);
  }

  // ------------------------------------------------------------ refresh / logout

  /**
   * Rotates the refresh token. Each refresh creates a new session row in the same family and marks the old one rotated.
   * Presenting a rotated token again means it leaked, so the whole family is revoked and the caller must log in.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedTokens> {
    const hash = this.hashRefresh(refreshToken);
    const now = new Date();
    const current = await this.db.selectFrom('authSessions').selectAll().where('refreshTokenHash', '=', hash).executeTakeFirst();
    if (!current || current.expiresAt <= now) throw new UnauthorizedError('Refresh token is invalid or expired', 'TOKEN_INVALID');
    const reuse = async () => {
      await this.db.updateTable('authSessions').set({ revokedAt: now, revokedReason: 'refresh_token_reuse' }).where('familyId', '=', current.familyId).where('revokedAt', 'is', null).execute();
      this.audit.logSafe({ meta }, { action: 'auth.refresh_reuse_detected', entityType: 'User', entityId: current.userId, userId: current.userId });
      return new UnauthorizedError('Refresh token was already used; all sessions of this login were revoked', 'TOKEN_REUSED');
    };
    if (current.rotatedAt) throw await reuse();
    if (current.revokedAt) throw new UnauthorizedError('Refresh token is invalid or expired', 'TOKEN_INVALID');
    // Conditional claim: of two concurrent refreshes with the same token, only one wins.
    const claimed = await this.db.updateTable('authSessions').set({ rotatedAt: now, lastUsedAt: now }).where('id', '=', current.id).where('rotatedAt', 'is', null).where('revokedAt', 'is', null).executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) throw await reuse();
    const user = await this.db.selectFrom('users').selectAll().where('id', '=', current.userId).executeTakeFirst();
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthorizedError('This account is not active', 'ACCOUNT_INACTIVE');
    // The old row stays (rotated) for reuse detection until it expires; it can no longer authorize requests.
    await this.db.updateTable('authSessions').set({ revokedAt: now, revokedReason: 'rotated' }).where('id', '=', current.id).execute();
    return this.startSession(user, meta, current.familyId);
  }

  async logout(user: AuthUser, meta: RequestMeta): Promise<void> {
    const s = await this.db.selectFrom('authSessions').select('familyId').where('id', '=', user.sessionId).executeTakeFirst();
    if (s) await this.db.updateTable('authSessions').set({ revokedAt: new Date(), revokedReason: 'logout' }).where('familyId', '=', s.familyId).where('revokedAt', 'is', null).execute();
    this.audit.logSafe({ user, meta }, { action: 'auth.logout', entityType: 'User', entityId: user.userId });
  }

  // ------------------------------------------------------------ password reset

  /** Always succeeds from the caller's view, so it cannot be used to discover accounts. */
  async forgotPassword(dto: ForgotPasswordDto, meta: RequestMeta): Promise<void> {
    const user = await this.db.selectFrom('users').select(['id', 'email', 'name', 'status']).where('email', '=', dto.email.trim().toLowerCase()).executeTakeFirst();
    if (!user || ![UserStatus.ACTIVE, UserStatus.INVITED].includes(user.status as UserStatus)) return;
    await this.resets.issue(user, 'RESET');
    this.audit.logSafe({ meta }, { action: 'auth.password_reset_requested', entityType: 'User', entityId: user.id, userId: user.id });
  }

  async resetPassword(dto: ResetPasswordDto, meta: RequestMeta): Promise<void> {
    const userId = await this.resets.consume(dto.token);
    if (!userId) throw new UnauthorizedError('Reset link is invalid or has expired', 'TOKEN_INVALID');
    const passwordHash = await hashPassword(dto.newPassword);
    const now = new Date();
    await runInTransaction(this.db, async (tx) => {
      // Invited users become ACTIVE by choosing a password; suspended accounts stay suspended.
      await tx
        .updateTable('users')
        .set({ passwordHash, status: sql<string>`case when status = ${UserStatus.INVITED} then ${UserStatus.ACTIVE} else status end` })
        .where('id', '=', userId)
        .execute();
      await tx.updateTable('authSessions').set({ revokedAt: now, revokedReason: 'password_reset' }).where('userId', '=', userId).where('revokedAt', 'is', null).execute();
    });
    this.audit.logSafe({ meta }, { action: 'auth.password_reset', entityType: 'User', entityId: userId, userId });
  }

  /**
   * A signed-in user changes their own password. The current password must be right (a stolen access token alone is not
   * enough), the new one must differ, and every OTHER login of this account is ended; the one making the change stays in.
   * A wrong current password is a 400 (not a 401), so the web client does not mistake it for an expired session.
   */
  async changePassword(user: AuthUser, dto: ChangePasswordDto, meta: RequestMeta): Promise<void> {
    const row = await this.db.selectFrom('users').select('passwordHash').where('id', '=', user.userId).executeTakeFirst();
    if (!row || !(await verifyPassword(dto.currentPassword, row.passwordHash))) {
      this.audit.logSafe({ user, meta }, { action: 'auth.password_change_failed', entityType: 'User', entityId: user.userId });
      throw new DomainValidationError('Current password is incorrect', { fields: { currentPassword: ['is incorrect'] } });
    }
    if (dto.newPassword === dto.currentPassword) {
      throw new DomainValidationError('Choose a password you have not used just now', { fields: { newPassword: ['must differ from the current password'] } });
    }
    const passwordHash = await hashPassword(dto.newPassword);
    const current = await this.db.selectFrom('authSessions').select('familyId').where('id', '=', user.sessionId).executeTakeFirst();
    const now = new Date();
    await runInTransaction(this.db, async (tx) => {
      await tx.updateTable('users').set({ passwordHash }).where('id', '=', user.userId).execute();
      let revoke = tx.updateTable('authSessions').set({ revokedAt: now, revokedReason: 'password_changed' }).where('userId', '=', user.userId).where('revokedAt', 'is', null);
      if (current) revoke = revoke.where('familyId', '<>', current.familyId);
      await revoke.execute();
    });
    this.audit.logSafe({ user, meta }, { action: 'auth.password_changed', entityType: 'User', entityId: user.userId });
  }

  // ------------------------------------------------------------ internals

  private async startSession(user: User, meta: RequestMeta, familyId?: string): Promise<IssuedTokens> {
    const jwtCfg = this.config.get('jwt', { infer: true });
    const refreshToken = randomBytes(48).toString('base64url');
    const now = new Date();
    const session = await this.db
      .insertInto('authSessions')
      .values({
        userId: user.id,
        familyId: familyId ?? randomUUID(),
        refreshTokenHash: this.hashRefresh(refreshToken),
        expiresAt: new Date(now.getTime() + jwtCfg.refreshTtlDays * 86_400_000),
        ip: meta.ip?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        lastUsedAt: now,
        revokedAt: null,
        revokedReason: null,
        rotatedAt: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const claims: AccessTokenClaims = { sub: user.id, sid: session.id, org: user.organizationId, role: user.role };
    const accessToken = await this.jwt.signAsync(claims);
    const { passwordHash: _omit, ...publicUser } = user;
    return { accessToken, refreshToken, expiresIn: jwtCfg.accessTtlSeconds, user: toPublicUser(publicUser as PublicUser) };
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
