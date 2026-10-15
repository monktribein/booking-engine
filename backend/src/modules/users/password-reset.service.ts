import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { createHmac, randomBytes } from 'node:crypto';
import { Connection, Types } from 'mongoose';
import type { AppConfig } from '../../config/configuration';
import { encryptSecret } from '../../database/common/crypto';
import { NotificationChannel, NotificationType } from '../../database/enums';
import { Models, getModels } from '../../database/models';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';

const RESET_TTL_MS = 30 * 60_000;
const INVITE_TTL_MS = 7 * 24 * 3600_000;

/**
 * One-time password-reset / invitation links. Only an HMAC of the token is
 * stored. The link travels to the email sender encrypted in the notification's
 * metadata, and the sender removes it after sending, so the database never
 * holds a usable plaintext link.
 */
@Injectable()
export class PasswordResetService {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly outbox: OutboxDispatcher,
  ) {
    this.m = getModels(connection);
  }

  hashToken(token: string): string {
    return createHmac('sha256', this.config.get('jwt', { infer: true }).refreshSecret).update(`reset:${token}`).digest('hex');
  }

  async issue(user: { _id: Types.ObjectId; email: string; name: string }, kind: 'RESET' | 'INVITE', propertyId?: Types.ObjectId): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.m.PasswordResetToken.create({
      userId: user._id,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + (kind === 'INVITE' ? INVITE_TTL_MS : RESET_TTL_MS)),
    });
    const link = `${this.config.get('appUrl', { infer: true })}/reset-password?token=${token}`;
    // Notifications are property-scoped; account emails use the user's first property, or a nil id.
    const pid = propertyId ?? (await this.m.PropertyUser.findOne({ userId: user._id }, { propertyId: 1 }).lean())?.propertyId ?? new Types.ObjectId('000000000000000000000000');
    await this.m.Notification.create({
      propertyId: pid,
      userId: user._id,
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
  async consume(token: string): Promise<Types.ObjectId | null> {
    const doc = await this.m.PasswordResetToken.findOneAndUpdate(
      { tokenHash: this.hashToken(token), usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { new: true },
    ).lean();
    return doc?.userId ?? null;
  }
}
