import { Controller, Get, HttpCode, Inject, Injectable, Logger, Module, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { SmtpEmailSender } from './smtp-email.sender';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { sql } from 'kysely';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseUuidPipe, pageParams } from '../../common/utils';
import { decryptSecret } from '../../database/common/crypto';
import { NOTIFICATION_EVENT, NotificationChannel, NotificationStatus, NotificationType } from '../../database/enums';
import { NotFoundError } from '../../database/errors';
import type { Notification } from '../../database/db-types';
import { Db, InjectDb } from '../../database/kysely';
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
  constructor(@InjectDb() private readonly db: Db) {}

  async inbox(user: AuthUser, q: InboxQueryDto) {
    const p = pageParams(q.page, q.limit);
    let query = this.db.selectFrom('notifications').where('userId', '=', user.userId).where('channel', '=', NotificationChannel.IN_APP);
    query = q.unread ? query.where('status', 'in', [NotificationStatus.QUEUED, NotificationStatus.SENT]) : query.where('status', '!=', NotificationStatus.FAILED);
    const [items, total] = await Promise.all([
      query
        .select(['id', 'propertyId', 'userId', 'reservationId', 'type', 'channel', 'status', 'subject', 'message', 'sentAt', 'readAt', 'createdAt'])
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .offset(p.skip)
        .limit(p.limit)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  async markRead(user: AuthUser, id: string) {
    const n = await this.db
      .updateTable('notifications')
      .set({ status: NotificationStatus.READ, readAt: new Date() })
      .where('id', '=', id)
      .where('userId', '=', user.userId)
      .where('channel', '=', NotificationChannel.IN_APP)
      .returning('id')
      .executeTakeFirst();
    if (!n) throw new NotFoundError('Notification', id);
    return { ok: true };
  }
}

@Injectable()
export class NotificationJobHandler implements JobHandler<'notification'>, OnModuleInit {
  readonly queue = QUEUES.NOTIFICATION;
  private readonly senders: Map<NotificationChannel, NotificationSender>;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly registry: JobHandlerRegistry,
    @Inject(EMAIL_SENDER) email: NotificationSender,
    sms: LogSmsSender,
    whatsapp: LogWhatsAppSender,
    inApp: InAppSender,
  ) {
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
    const n = await this.db
      .updateTable('notifications')
      .set({ lockedUntil: new Date(now.getTime() + 60_000), attempts: sql<number>`attempts + 1` })
      .where('id', '=', ctx.data.notificationId)
      .where('status', '=', NotificationStatus.QUEUED)
      .where((w) => w.or([w('lockedUntil', 'is', null), w('lockedUntil', '<', now)]))
      .returningAll()
      .executeTakeFirst();
    if (!n) return { status: 'SKIPPED_ALREADY_HANDLED' };
    try {
      const sender = this.senders.get(n.channel as NotificationChannel);
      if (!sender) throw nonRetryable(new Error(`No sender for ${n.channel}`));
      const res = await sender.send({ id: n.id, event: NOTIFICATION_EVENT[n.type as NotificationType], recipient: n.recipient ?? String(n.userId), subject: n.subject ?? undefined, body: this.render(n) });
      // One-time links are removed once delivered, so the database never keeps a usable link.
      await this.db
        .updateTable('notifications')
        .set({
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          lockedUntil: null,
          lastError: null,
          metadata: sql<Record<string, unknown>>`(metadata - 'encryptedLink') || jsonb_build_object('providerMessageId', ${res.providerMessageId ?? null}::text)` as never,
        })
        .where('id', '=', n.id)
        .execute();
      return { status: 'SENT' };
    } catch (err) {
      const final = (err as Error).name === 'UnrecoverableError' || isFinalAttempt(ctx);
      await this.db
        .updateTable('notifications')
        .set({ status: final ? NotificationStatus.FAILED : NotificationStatus.QUEUED, lockedUntil: null, lastError: (err as Error).message.slice(0, 2000) })
        .where('id', '=', n.id)
        .execute();
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
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUuidPipe) id: string) {
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
