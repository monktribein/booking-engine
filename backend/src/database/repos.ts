import { redactSecrets } from './common/redact';
import type { NotificationsTable } from './db-types';
import { Db, j } from './kysely';
import type { Insertable } from 'kysely';

/** A notification as callers write it: metadata is a plain object (it is redacted and serialised here). */
export type NewNotification = Omit<Insertable<NotificationsTable>, 'metadata'> & { metadata?: Record<string, unknown> };

const toRow = (n: NewNotification): Insertable<NotificationsTable> => ({ ...n, metadata: j(redactSecrets(n.metadata ?? {})) });

/** Notifications are the outbox for e-mail/SMS/in-app delivery: insert inside the transaction that caused them. */
export async function insertNotification(q: Db, n: NewNotification) {
  return q.insertInto('notifications').values(toRow(n)).returningAll().executeTakeFirstOrThrow();
}

export async function insertNotifications(q: Db, rows: NewNotification[]) {
  if (!rows.length) return [];
  return q.insertInto('notifications').values(rows.map(toRow)).returningAll().execute();
}
