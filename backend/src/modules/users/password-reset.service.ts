import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { encryptSecret } from '../../database/common/crypto';
import { NotificationChannel, NotificationType } from '../../database/enums';
import { Db, InjectDb } from '../../database/kysely';
import { insertNotification } from '../../database/repos';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';

const RESET_TTL_MS = 30 * 60_000;
const INVITE_TTL_MS = 7 * 24 * 3600_000;

/**
 * One-time password-reset / invitation links. Only an HMAC of the token is stored. The link travels to the email sender
 * encrypted in the notification's metadata, and the sender removes it after sending, so the database never holds a
 * usable plaintext link.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly outbox: OutboxDispatcher,
  ) {}

  hashToken(token: string): string {
    return createHmac('sha256', this.config.get('jwt', { infer: true }).refreshSecret).update(`reset:${token}`).digest('hex');
  }

  async issue(user: { id: string; email: string; name: string }, kind: 'RESET' | 'INVITE', propertyId?: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.db
      .insertInto('passwordResetTokens')
      .values({ userId: user.id, tokenHash: this.hashToken(token), expiresAt: new Date(Date.now() + (kind === 'INVITE' ? INVITE_TTL_MS : RESET_TTL_MS)), usedAt: null })
      .execute();
    const link = `${this.config.get('appUrl', { infer: true })}/reset-password?token=${token}`;
    // Notifications are property-scoped when possible; account emails of a user without any property carry no property.
    const pid = propertyId ?? (await this.db.selectFrom('propertyUsers').select('propertyId').where('userId', '=', user.id).limit(1).executeTakeFirst())?.propertyId ?? null;
    await insertNotification(this.db, {
      propertyId: pid,
      userId: user.id,
      type: NotificationType.PASSWORD_RESET,
      channel: NotificationChannel.EMAIL,
      recipient: user.email,
      subject: kind === 'INVITE' ? 'You have been invited to Tirvona' : 'Reset your Tirvona password',
      message:
        kind === 'INVITE'
          ? `Hi ${user.name}, you have been invited to Tirvona. Use the link in this email to set your password (valid 7 days).`
          : `Hi ${user.name}, use the link in this email to reset your password (valid 30 minutes). If you did not ask for this, ignore it.`,
      metadata: { encryptedLink: encryptSecret(link) },
    });
    void this.outbox.flush();
  }

  /** Returns the userId if the token is valid and unused, marking it used atomically. */
  async consume(token: string): Promise<string | null> {
    const row = await this.db
      .updateTable('passwordResetTokens')
      .set({ usedAt: new Date() })
      .where('tokenHash', '=', this.hashToken(token))
      .where('usedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .returning('userId')
      .executeTakeFirst();
    return row?.userId ?? null;
  }
}
