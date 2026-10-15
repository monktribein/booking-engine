import { Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { NotificationChannel } from '../../database/enums';
import { nonRetryable } from '../../jobs/job-handler';
import type { NotificationSender, OutboundMessage } from './notifications.module';

/**
 * E-mail through any SMTP service (SES SMTP interface, Postmark, Mailgun, Gmail relay, a local test server...).
 * Selected by the NOTIFICATION email provider factory when SMTP_URL is set; otherwise the logging sender is used.
 *
 * Delivery semantics:
 *  - A deterministic Message-ID per notification (`<ntf-<id>@host>`) lets a provider or recipient recognise the rare
 *    duplicate when a worker crashes after the provider accepted the message but before the database was updated.
 *  - 4xx / network / timeout errors are thrown as-is so the queue retries them with backoff.
 *  - 5xx SMTP replies (unknown mailbox, rejected content) are permanent: they are wrapped as non-retryable so the notification
 *    is marked FAILED immediately instead of being retried for hours.
 *  - Only a masked recipient is logged; the body is never logged.
 */
export class SmtpEmailSender implements NotificationSender {
  readonly channel = NotificationChannel.EMAIL;
  private readonly logger = new Logger('SmtpEmail');
  private readonly transporter: Transporter;
  private readonly domain: string;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transporter = nodemailer.createTransport({ url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, pool: false } as SMTPTransport.Options);
    this.domain = (/@([^>\s]+)>?\s*$/.exec(from)?.[1] ?? 'tirvona.local').toLowerCase();
  }

  async send(msg: OutboundMessage): Promise<{ providerMessageId?: string }> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: msg.recipient,
        subject: msg.subject ?? msg.event,
        text: msg.body,
        ...(msg.id ? { messageId: `<ntf-${msg.id}@${this.domain}>` } : {}),
      });
      if (info.rejected?.length) throw Object.assign(new Error(`recipient rejected by the mail server`), { responseCode: 550 });
      this.logger.log(`[EMAIL] ${msg.event} accepted by the mail server`);
      return { providerMessageId: info.messageId };
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      if (typeof code === 'number' && code >= 500 && code < 600) throw nonRetryable(new Error(`SMTP ${code}: ${(err as Error).message}`.slice(0, 300)));
      throw err;
    }
  }
}
