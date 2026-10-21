import { sql } from 'kysely';
import { formatDateOnly } from '../common/dates';
import { j } from '../kysely';
import type { Db } from '../kysely';

/**
 * Personal-data retention. See docs/DATA_RETENTION.md for the inventory of personal data and what is kept on purpose.
 *
 * What this module does, and nothing else:
 *   - GUESTS: when every stay of a guest ended (or was cancelled) more than `guestAnonymizeAfterDays` ago and nothing is open
 *     (no live booking, no unsettled refund), the guest profile and the guest snapshots/special requests on their reservations
 *     are replaced with "Anonymized Guest". Reservations, dates, amounts, payments, refunds and the audit trail stay, so
 *     reporting, accounting and booking evidence are unchanged and no foreign key breaks.
 *   - NOTIFICATIONS: recipient, subject and body of delivered/failed/read messages older than `notificationRedactAfterDays` are blanked.
 *   - INBOUND CHANNEL EVENTS: the raw payload of processed/ignored/failed events older than `inboundPayloadRedactAfterDays` is replaced
 *     with a marker (the row, its external id and status stay, so a replay is still recognised).
 *
 * Safety properties: runs per organization; a real run needs a policy that is both enabled and approved by an owner; a dry run
 * changes nothing and counts what a real run would touch; it is idempotent (anonymised rows are skipped); each real run touches
 * at most `batch` guests, so it is short and can simply be run again; the run record holds counts only, never personal data.
 */

export interface RetentionSummary {
  guests: number;
  reservations: number;
  notifications: number;
  inboundEvents: number;
}

export interface RetentionResult {
  organizationId: string;
  dryRun: boolean;
  /** False when nothing was done for a policy reason (see `reason`). A dry run is always "applied: false" by definition. */
  applied: boolean;
  reason?: string;
  summary: RetentionSummary;
  /** More eligible guests remain than one batch handles; run again. */
  moreGuests: boolean;
}

export const ANONYMIZED_FIRST_NAME = 'Anonymized';
/** notifications.recipient must be non-null for e-mail/SMS rows; a reserved, undeliverable address (RFC 2606) stands in. */
export const REDACTED_RECIPIENT = 'redacted@redacted.invalid';
const SETTLED = ['SENT', 'DELIVERED', 'FAILED', 'READ'] as const;
export const ANONYMIZED_LAST_NAME = 'Guest';
const DEFAULT_BATCH = 500;
const DAY_MS = 86_400_000;

interface Rows<T> {
  rows: T[];
}

/** Guests whose data may be anonymised under the cutoff. `limit` null = count them all. */
async function eligibleGuestIds(db: Db, organizationId: string, cutoff: Date, limit: number | null): Promise<string[]> {
  const cutoffDate = formatDateOnly(cutoff);
  const res = (await sql<{ id: string }>`
    select g.id
    from guests g
    join properties p on p.id = g.property_id
    where p.organization_id = ${organizationId}
      and g.anonymized_at is null
      and g.created_at < ${cutoff} and g.updated_at < ${cutoff}
      and not exists (
        select 1 from reservations r
        where r.guest_id = g.id
          and (r.status in ('PENDING','CONFIRMED','CHECKED_IN') or r.check_out >= ${cutoffDate}::date or r.updated_at >= ${cutoff})
      )
      and not exists (
        select 1 from refunds f join reservations r2 on r2.id = f.reservation_id
        where r2.guest_id = g.id and f.status in ('PENDING','PROCESSING')
      )
    order by g.id
    ${limit === null ? sql`` : sql`limit ${limit}`}
  `.execute(db)) as Rows<{ id: string }>;
  return res.rows.map((r) => r.id);
}

async function countReservations(db: Db, guestIds: string[]): Promise<number> {
  if (!guestIds.length) return 0;
  const r = await db.selectFrom('reservations').select((eb) => eb.fn.countAll<string>().as('n')).where('guestId', 'in', guestIds).executeTakeFirstOrThrow();
  return Number(r.n);
}

function notificationWhere(cutoff: Date) {
  return sql`redacted_at is null and status in ('SENT','DELIVERED','FAILED','READ') and created_at < ${cutoff}`;
}

function inboundWhere(cutoff: Date) {
  return sql`payload_redacted_at is null and status in ('PROCESSED','IGNORED','FAILED') and updated_at < ${cutoff}`;
}

async function countInbound(db: Db, organizationId: string, cutoff: Date): Promise<number> {
  const res = (await sql<{ n: string }>`
    select count(*) as n from webhook_events
    where ${inboundWhere(cutoff)}
      and property_id in (select id from properties where organization_id = ${organizationId})
  `.execute(db)) as Rows<{ n: string }>;
  return Number(res.rows[0].n);
}

async function countNotifications(db: Db, organizationId: string, cutoff: Date): Promise<number> {
  const res = (await sql<{ n: string }>`
    select count(*) as n from notifications n
    where ${notificationWhere(cutoff)}
      and n.property_id in (select id from properties where organization_id = ${organizationId})
  `.execute(db)) as Rows<{ n: string }>;
  return Number(res.rows[0].n);
}

export async function runRetention(db: Db, organizationId: string, opts: { dryRun: boolean; triggeredBy: string; now?: Date; batch?: number }): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? DEFAULT_BATCH;
  const empty: RetentionSummary = { guests: 0, reservations: 0, notifications: 0, inboundEvents: 0 };
  const policy = await db.selectFrom('dataRetentionPolicies').selectAll().where('organizationId', '=', organizationId).executeTakeFirst();
  const record = async (summary: RetentionSummary) => {
    await db.insertInto('dataRetentionRuns').values({ organizationId, dryRun: opts.dryRun, triggeredBy: opts.triggeredBy.slice(0, 80), summary: j(summary) }).execute();
  };

  if (!policy) return { organizationId, dryRun: opts.dryRun, applied: false, reason: 'No retention policy is configured for this organization', summary: empty, moreGuests: false };
  if (!opts.dryRun && (!policy.enabled || !policy.approvedAt)) {
    return { organizationId, dryRun: false, applied: false, reason: 'The policy is not enabled and approved by an owner', summary: empty, moreGuests: false };
  }

  const guestCutoff = policy.guestAnonymizeAfterDays === null ? null : new Date(now.getTime() - policy.guestAnonymizeAfterDays * DAY_MS);
  const notifCutoff = policy.notificationRedactAfterDays === null ? null : new Date(now.getTime() - policy.notificationRedactAfterDays * DAY_MS);
  const inboundCutoff = policy.inboundPayloadRedactAfterDays === null ? null : new Date(now.getTime() - policy.inboundPayloadRedactAfterDays * DAY_MS);

  if (opts.dryRun) {
    const ids = guestCutoff ? await eligibleGuestIds(db, organizationId, guestCutoff, null) : [];
    let reservations = 0;
    for (let i = 0; i < ids.length; i += 1000) reservations += await countReservations(db, ids.slice(i, i + 1000));
    const summary = {
      guests: ids.length,
      reservations,
      notifications: notifCutoff ? await countNotifications(db, organizationId, notifCutoff) : 0,
      inboundEvents: inboundCutoff ? await countInbound(db, organizationId, inboundCutoff) : 0,
    };
    await record(summary);
    return { organizationId, dryRun: true, applied: false, summary, moreGuests: false };
  }

  const summary: RetentionSummary = { guests: 0, reservations: 0, notifications: 0, inboundEvents: 0 };
  let moreGuests = false;

  if (guestCutoff) {
    // Batch of batch+1 only to learn whether more remain.
    const found = await eligibleGuestIds(db, organizationId, guestCutoff, batch + 1);
    moreGuests = found.length > batch;
    const ids = found.slice(0, batch);
    if (ids.length) {
      await db.transaction().execute(async (tx) => {
        const anonymizedSnapshot = JSON.stringify({ firstName: ANONYMIZED_FIRST_NAME, lastName: ANONYMIZED_LAST_NAME });
        const res = await tx
          .updateTable('reservations')
          .set({ guest: anonymizedSnapshot, specialRequests: null })
          .where('guestId', 'in', ids)
          .executeTakeFirst();
        summary.reservations = Number(res.numUpdatedRows);
        // The messages about those stays carried the guest's address and name.
        await tx
          .updateTable('notifications')
          .set({ recipient: REDACTED_RECIPIENT, subject: null, message: '[redacted]', redactedAt: now })
          .where('redactedAt', 'is', null)
          // A message still waiting to be sent is never rewritten: the worker would send the placeholder.
          .where('status', 'in', [...SETTLED])
          .where('reservationId', 'in', tx.selectFrom('reservations').select('id').where('guestId', 'in', ids))
          .execute();
        const g = await tx
          .updateTable('guests')
          .set({ firstName: ANONYMIZED_FIRST_NAME, lastName: ANONYMIZED_LAST_NAME, email: null, phone: null, notes: null, documents: '[]', anonymizedAt: now })
          .where('id', 'in', ids)
          .where('anonymizedAt', 'is', null)
          .executeTakeFirst();
        summary.guests = Number(g.numUpdatedRows);
      });
    }
  }

  if (notifCutoff) {
    const res = (await sql`
      update notifications set recipient = ${REDACTED_RECIPIENT}, subject = null, message = '[redacted]', redacted_at = ${now}
      where ${notificationWhere(notifCutoff)}
        and property_id in (select id from properties where organization_id = ${organizationId})
    `.execute(db)) as { numAffectedRows?: bigint };
    summary.notifications = Number(res.numAffectedRows ?? 0);
  }

  if (inboundCutoff) {
    const res = (await sql`
      update webhook_events set payload = '{"redacted":true}'::jsonb, payload_redacted_at = ${now}
      where ${inboundWhere(inboundCutoff)}
        and property_id in (select id from properties where organization_id = ${organizationId})
    `.execute(db)) as { numAffectedRows?: bigint };
    summary.inboundEvents = Number(res.numAffectedRows ?? 0);
  }

  await record(summary);
  return { organizationId, dryRun: false, applied: true, summary, moreGuests };
}

/** Organizations with an enabled, owner-approved policy: the only ones the scheduled job touches. */
export async function organizationsWithActivePolicy(db: Db): Promise<string[]> {
  const rows = await db.selectFrom('dataRetentionPolicies').select('organizationId').where('enabled', '=', true).where('approvedAt', 'is not', null).execute();
  return rows.map((r) => r.organizationId);
}
