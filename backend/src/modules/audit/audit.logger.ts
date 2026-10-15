import { Global, Injectable, Logger, Module } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import type { Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { AuditService } from '../../database/services/audit.service';

export interface AuditActor {
  user?: AuthUser | null;
  meta?: RequestMeta;
}

export interface AuditRecord {
  action: string;
  entityType: string;
  entityId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;
  organizationId?: Types.ObjectId | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  /** Override the actor (e.g. a failed login has no authenticated user). */
  userId?: Types.ObjectId | null;
}

/**
 * Request-aware audit logging: adds actor, IP and user agent. Values pass
 * through redactSecrets in the schema, so tokens and passwords never land
 * in audit_logs. Pass `session` to commit the entry with the change it describes.
 */
@Injectable()
export class AuditLogger {
  private readonly logger = new Logger('Audit');

  constructor(private readonly audit: AuditService) {}

  async log(actor: AuditActor, rec: AuditRecord, session: ClientSession | null = null): Promise<void> {
    await this.audit.record(session, {
      organizationId: rec.organizationId ?? actor.user?.organizationId ?? null,
      propertyId: rec.propertyId ?? null,
      userId: rec.userId !== undefined ? rec.userId : actor.user?.userId ?? null,
      action: rec.action,
      entityType: rec.entityType,
      entityId: rec.entityId,
      before: rec.before ?? null,
      after: rec.after ?? null,
      metadata: { ...(rec.metadata ?? {}), ip: actor.meta?.ip, userAgent: actor.meta?.userAgent },
    });
  }

  /** For non-critical audit events outside a transaction: never fail the request because of the audit write. */
  logSafe(actor: AuditActor, rec: AuditRecord): void {
    this.log(actor, rec).catch((err) => this.logger.error(`audit write failed for ${rec.action}: ${(err as Error).message}`));
  }
}

@Global()
@Module({ providers: [AuditLogger], exports: [AuditLogger] })
export class AuditModule {}
