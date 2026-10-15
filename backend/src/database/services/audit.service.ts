import { Injectable } from '@nestjs/common';
import { redactSecrets } from '../common/redact';
import { Db, InjectDb, j } from '../kysely';

type Id = string;

export interface AuditEntry {
  organizationId?: Id | null;
  propertyId?: Id | null;
  userId?: Id | null;
  action: string;
  entityType: string;
  entityId: Id;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@InjectDb() private readonly db: Db) {}

  /**
   * Pass the transaction to make the audit row commit or roll back with the change it describes. Values pass through
   * redactSecrets (tokens, passwords, card numbers never reach audit_logs). The table is append-only (a trigger rejects
   * UPDATE and DELETE).
   */
  async record(q: Db | null, entry: AuditEntry): Promise<void> {
    await (q ?? this.db)
      .insertInto('auditLogs')
      .values({
        organizationId: entry.organizationId ?? null,
        propertyId: entry.propertyId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before ? j(redactSecrets(plain(entry.before))) : null,
        after: entry.after ? j(redactSecrets(plain(entry.after))) : null,
        metadata: j(redactSecrets(plain(entry.metadata ?? {}))),
      })
      .execute();
  }
}

/** JSON round-trip: Dates become ISO strings and undefined keys disappear, exactly what jsonb would store. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
