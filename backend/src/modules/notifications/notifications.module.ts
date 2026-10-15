import { Controller, Get, HttpCode, Inject, Injectable, Logger, Module, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { SmtpEmailSender } from './smtp-email.sender';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { Connection, Types } from 'mongoose';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseObjectIdPipe, pageParams } from '../../common/utils';
import { decryptSecret } from '../../database/common/crypto';
import { NOTIFICATION_EVENT, NotificationChannel, NotificationStatus, NotificationType } from '../../database/enums';
import { NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { Notification } from '../../database/schemas/ops.schema';
import { JobContext, JobHandler, JobHandlerRegistry, isFinalAttempt, nonRetryable } from '../../jobs/job-handler';
import { QUEUES } from '../../jobs/queues';

// ------------------------------------------------------------------ provider abstraction

export interface OutboundMessage {
  /** The notification id, used by providers to build a deterministic message id. */
  id?: string;
  event: string;
  recipient: string;
  subject?: string;
  body: string;
}

/**
 * One sender per delivery channel. The default implementations log a masked
 * summary. Plug in real providers (e.g. SES/SMTP, an SMS gateway, the
 * WhatsApp Business Platform) by binding a class to the token. No other code changes.
 */
export interface NotificationSender {
  readonly channel: NotificationChannel;
  send(msg: OutboundMessage): Promise<{ providerMessageId?: string }>;
}

export const NOTIFICATION_SENDERS = Symbol('NOTIFICATION_SENDERS');

/** The e-mail provider: SMTP when SMTP_URL is configured, otherwise the logging sender (nothing is delivered). */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

const mask = (s: string) => (s.includes('@') ? s.replace(/^(.).*(@.*)$/, '$1***$2') : s.replace(/.(?=.{3})/g, '*'));

abstract class LogSender implements NotificationSender {
  abstract readonly channel: NotificationChannel;
  private readonly logger = new Logger('Notify');
  async send(msg: OutboundMessage) {
    // Never log the body: it can contain personal data or one-time links.
    this.logger.log(`[${this.channel}] ${msg.event} → ${mask(msg.recipient)}${msg.subject ? ` "${msg.subject}"` : ''}`);
    return { providerMessageId: `log-${Date.now()}` };
  }
}
@Injectable() export class LogEmailSender extends LogSender { readonly channel = NotificationChannel.EMAIL; }
@Injectable() export class LogSmsSender extends LogSender { readonly channel = NotificationChannel.SMS; }
@Injectable() export class LogWhatsAppSender extends LogSender { readonly channel = NotificationChannel.WHATSAPP; }

/** In-app notifications are the stored row itself; "sending" just makes it visible in the inbox. */
@Injectable()
export class InAppSender implements NotificationSender {
  readonly channel = NotificationChannel.IN_APP;
  async send() {
    return {};
  }
}

// ------------------------------------------------------------------ service + worker

@Injectable()
export class NotificationsService {
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

  inbox(user: AuthUser, q: InboxQueryDto) {
    const p = pageParams(q.page, q.limit);
    const filter = {
      userId: user.userId,
      channel: NotificationChannel.IN_APP,
      status: q.unread ? { $in: [NotificationStatus.QUEUED, NotificationStatus.SENT] } : { $ne: NotificationStatus.FAILED },
    };
    return Promise.all([
      this.m.Notification.find(filter, { metadata: 0 }).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      this.m.Notification.countDocuments(filter),
    ]).then(([items, total]) => ({ items, page: p.page, limit: p.limit, total }));
  }

  async markRead(user: AuthUser, id: Types.ObjectId) {
    const n = await this.m.Notification.findOneAndUpdate(
      { _id: id, userId: user.userId, channel: NotificationChannel.IN_APP },
      { $set: { status: NotificationStatus.READ, readAt: new Date() } },
      { new: true },
    ).lean();
    if (!n) throw new NotFoundError('Notification', id);
    return { ok: true };
  }
}

@Injectable()
export class NotificationJobHandler implements JobHandler<'notification'>, OnModuleInit {
  readonly queue = QUEUES.NOTIFICATION;
  private readonly m: Models;
  private readonly senders: Map<NotificationChannel, NotificationSender>;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly registry: JobHandlerRegistry,
    @Inject(EMAIL_SENDER) email: NotificationSender,
    sms: LogSmsSender,
    whatsapp: LogWhatsAppSender,
    inApp: InAppSender,
  ) {
    this.m = getModels(connection);
    this.senders = new Map([email, sms, whatsapp, inApp].map((s) => [s.channel, s] as const));
  }

  onModuleInit() {
    this.registry.register(this);
    if (this.senders.get(NotificationChannel.EMAIL) instanceof LogEmailSender && process.env.NODE_ENV === 'production') {
      new Logger('Notify').warn('E-mail delivery is NOT configured (SMTP_URL unset): booking confirmations are only logged, guests receive nothing');
    }
  }

  async handle(ctx: JobContext<'notification'>) {
    const now = new Date();
    // Lease: only one worker sends a given notification at a time.
    const n = await this.m.Notification.findOneAndUpdate(
      { _id: ctx.data.notificationId, status: NotificationStatus.QUEUED, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { $set: { lockedUntil: new Date(now.getTime() + 60_000) }, $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if (!n) return { status: 'SKIPPED_ALREADY_HANDLED' };
    try {
      const sender = this.senders.get(n.channel);
      if (!sender) throw nonRetryable(new Error(`No sender for ${n.channel}`));
      const res = await sender.send({ id: String(n._id), event: NOTIFICATION_EVENT[n.type], recipient: n.recipient ?? String(n.userId), subject: n.subject, body: this.render(n) });
      await this.m.Notification.updateOne(
        { _id: n._id },
        // One-time links are removed once delivered, so the database never keeps a usable link.
        { $set: { status: NotificationStatus.SENT, sentAt: new Date(), lockedUntil: null, lastError: null, 'metadata.providerMessageId': res.providerMessageId ?? null }, $unset: { 'metadata.encryptedLink': 1 } },
      );
      return { status: 'SENT' };
    } catch (err) {
      const final = (err as Error).name === 'UnrecoverableError' || isFinalAttempt(ctx);
      await this.m.Notification.updateOne(
        { _id: n._id },
        { $set: { status: final ? NotificationStatus.FAILED : NotificationStatus.QUEUED, lockedUntil: null, lastError: (err as Error).message.slice(0, 2000) } },
      );
      throw final ? nonRetryable(err) : err;
    }
  }

  private render(n: Notification): string {
    const link = (n.metadata as { encryptedLink?: string }).encryptedLink;
    if (n.type === NotificationType.PASSWORD_RESET && link) return `${n.message}\n\n${decryptSecret(link)}`;
    return n.message;
  }
}

// ------------------------------------------------------------------ controller

export class InboxQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Boolean) @IsBoolean() unread?: boolean;
}

class NotificationDto {
  @ApiProperty() _id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty({ enum: NotificationType }) type!: NotificationType;
  @ApiProperty() message!: string;
  @ApiProperty({ enum: NotificationStatus }) status!: NotificationStatus;
  @ApiPropertyOptional() reservationId?: string;
  @ApiProperty() createdAt!: string;
}

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'In-app notifications of the current user (new bookings, overbookings, sync failures...)' })
  @ApiEnvelope(NotificationDto, { paginated: true })
  @ApiStandardErrors()
  inbox(@CurrentUser() user: AuthUser, @Query() q: InboxQueryDto) {
    return this.notifications.inbox(user, q);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark an in-app notification read' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  read(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.notifications.markRead(user, id);
  }
}

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationJobHandler,
    LogEmailSender,
    LogSmsSender,
    LogWhatsAppSender,
    InAppSender,
    {
      provide: EMAIL_SENDER,
      inject: [ConfigService, LogEmailSender],
      useFactory: (config: ConfigService<AppConfig, true>, fallback: LogEmailSender): NotificationSender => {
        const smtp = config.get('smtp', { infer: true });
        return smtp.url ? new SmtpEmailSender(smtp.url, smtp.from as string) : fallback;
      },
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
