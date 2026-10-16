import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser, RequestMeta } from '../../../common/auth/auth-user';
import { addDays, formatDateOnly, todayIn } from '../../../database/common/dates';
import { ChannelConnectionStatus, ReconciliationIssueKind, ReconciliationIssueStatus, ReconciliationRunStatus, ReservationStatus } from '../../../database/enums';
import { ChannelError, DomainValidationError, NotFoundError } from '../../../database/errors';
import { Db, InjectDb, j } from '../../../database/kysely';
import { ChannelMappingService } from '../../../database/services/channel-mapping.service';
import { type NormalizedReservationEvent, WebhookService } from '../../../database/services/webhook.service';
import { OutboxDispatcher } from '../../../jobs/outbox.dispatcher';
import { AuditLogger } from '../../audit/audit.logger';
import { ChannelAdapterRegistry } from '../channel-registry';
import { ChannelsService } from '../channels.service';
import { redactText } from './provider-engine';

const LOOKBACK_DAYS = 30;
const MAX_REMOTE_CHECKS = 100;
const ACTIVE = new Set<string>([ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN]);

interface Found {
  kind: ReconciliationIssueKind;
  externalReservationId: string;
  reservationId?: string;
  details: Record<string, unknown>;
}

/**
 * Compares what a provider says it has with what Tirvona holds, per connection, and records the differences for staff.
 *
 * What it does on its own: a reservation the provider has and we do not is fed through the NORMAL ingest path (the same inbox,
 * mappings, inventory rules and idempotency as a webhook), but only when its listing and room are mapped. Everything else is
 * reported and left alone: a status or date difference, a booking we hold that the provider no longer knows. It never cancels,
 * moves or overwrites a reservation.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger('Reconciliation');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly registry: ChannelAdapterRegistry,
    private readonly channels: ChannelsService,
    private readonly mappings: ChannelMappingService,
    private readonly webhooks: WebhookService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {}

  async run(propertyId: string, channel: string, actor?: { user: AuthUser; meta: RequestMeta }) {
    const conn = await this.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', propertyId).where('channel', '=', channel).executeTakeFirst();
    if (!conn || !conn.providerId) throw new NotFoundError('Channel connection', channel);
    if (conn.status !== ChannelConnectionStatus.CONNECTED) throw new ChannelError('CHANNEL_NOT_CONNECTED', `${channel} is not connected for this property`, false);
    const adapter = await this.registry.forConnection(conn);
    if (adapter.supports && !adapter.supports('pullReservations')) {
      throw new DomainValidationError(`${adapter.displayName} cannot list reservations, so there is nothing to compare against`);
    }
    const property = await this.db.selectFrom('properties').select('timezone').where('id', '=', propertyId).executeTakeFirstOrThrow();
    const today = todayIn(property.timezone);
    const from = formatDateOnly(addDays(today, -1));
    const to = formatDateOnly(addDays(today, 365));
    const run = await this.db
      .insertInto('reconciliationRuns')
      .values({ connectionId: conn.id, propertyId, windowFrom: from, windowTo: to })
      .returningAll()
      .executeTakeFirstOrThrow();

    try {
      await this.channels.credentials(propertyId, adapter);
      const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
      const pull = await (adapter as unknown as { pullReservations(s: Date): Promise<{ events: NormalizedReservationEvent[]; skipped: { externalReservationId?: string; reason: string }[] }> }).pullReservations(since);
      const remote = new Map(pull.events.map((e) => [e.externalReservationId, e]));

      const local = await this.db
        .selectFrom('reservations')
        .select(['id', 'externalReservationId', 'status', 'checkIn', 'checkOut'])
        .where('propertyId', '=', propertyId)
        .where('source', '=', channel)
        .where('externalScope', '=', conn.id)
        .where('externalReservationId', 'is not', null)
        .where('checkOut', '>=', from as never)
        .execute();
      const localBy = new Map(local.map((l) => [l.externalReservationId as string, l]));
      const found: Found[] = [];
      let ingested = 0;

      for (const e of pull.events) {
        const l = localBy.get(e.externalReservationId);
        if (!l) {
          if (e.kind === 'RESERVATION_CANCELLED') continue; // nothing to cancel locally
          const resolved = await this.mappings.resolveInboundRoom(channel, e.externalListingId, e.rooms[0]?.externalRoomId ?? null, conn.id);
          if (!resolved?.mapping) {
            found.push({ kind: ReconciliationIssueKind.UNMAPPED, externalReservationId: e.externalReservationId, details: { externalListingId: e.externalListingId, externalRoomId: e.rooms[0]?.externalRoomId ?? null, checkIn: e.checkIn, checkOut: e.checkOut } });
            continue;
          }
          const res = await this.webhooks.ingest({
            channel,
            externalScope: conn.id,
            eventType: 'reconcile.created',
            externalEventId: `recon:${e.externalReservationId}:${e.revision ?? `${e.checkIn}:${e.checkOut}`}`,
            payload: { polled: true, reservation: { ...e, kind: 'RESERVATION_CREATED' } },
            signatureValid: true,
            propertyId,
          });
          if (!res.duplicate) ingested++;
          found.push({ kind: ReconciliationIssueKind.MISSING_LOCAL, externalReservationId: e.externalReservationId, details: { action: 'queued for import through the normal pipeline', checkIn: e.checkIn, checkOut: e.checkOut } });
          continue;
        }
        found.push(...this.compare(e, l));
      }

      // Reservations we hold that did not show up in the recent window: ask the provider about each one individually.
      let checked = 0;
      for (const l of local) {
        const id = l.externalReservationId as string;
        if (remote.has(id) || !ACTIVE.has(l.status) || checked >= MAX_REMOTE_CHECKS) continue;
        if (!adapter.supports || adapter.supports('getReservation')) {
          checked++;
          const e = await adapter.getReservation((await this.channels.credentials(propertyId, adapter)).creds, id);
          if (!e) found.push({ kind: ReconciliationIssueKind.MISSING_REMOTE, externalReservationId: id, reservationId: l.id, details: { localStatus: l.status, checkIn: String(l.checkIn).slice(0, 10), checkOut: String(l.checkOut).slice(0, 10) } });
          else found.push(...this.compare(e, l));
        }
      }
      for (const s of pull.skipped) {
        found.push({ kind: ReconciliationIssueKind.INGEST_FAILED, externalReservationId: s.externalReservationId ?? 'unknown', details: { reason: s.reason } });
      }

      const issueCount = await this.persist(run.id, conn.id, propertyId, found);
      if (ingested) void this.outbox.flush();
      await this.db.updateTable('reconciliationRuns').set({ status: ReconciliationRunStatus.COMPLETED, remoteCount: pull.events.length, localCount: local.length, issueCount, completedAt: new Date() }).where('id', '=', run.id).execute();
      if (actor) await this.audit.log(actor, { action: 'channel.reconcile', entityType: 'ChannelConnection', entityId: conn.id, propertyId, metadata: { channel, remote: pull.events.length, local: local.length, issues: issueCount, ingested } });
      return this.summary(run.id);
    } catch (err) {
      const message = redactText(err instanceof Error ? err.message : String(err)).slice(0, 1900);
      await this.db.updateTable('reconciliationRuns').set({ status: ReconciliationRunStatus.FAILED, error: message, completedAt: new Date() }).where('id', '=', run.id).execute();
      this.logger.warn(`reconciliation of ${channel} for ${propertyId} failed: ${message}`);
      throw err;
    }
  }

  /** Daily: every configured connection that has not been reconciled for a day. */
  async runDue(): Promise<number> {
    if (!this.registry.providersEnabled) return 0;
    const cutoff = new Date(Date.now() - 24 * 3_600_000);
    const conns = await this.db.selectFrom('channelConnections').select(['id', 'propertyId', 'channel']).where('status', '=', ChannelConnectionStatus.CONNECTED).where('providerId', 'is not', null).execute();
    let n = 0;
    for (const c of conns) {
      if (this.registry.isBuiltIn(c.channel)) continue;
      const last = await this.db.selectFrom('reconciliationRuns').select('startedAt').where('connectionId', '=', c.id).orderBy('startedAt', 'desc').limit(1).executeTakeFirst();
      if (last && last.startedAt > cutoff) continue;
      try {
        await this.run(c.propertyId, c.channel);
        n++;
      } catch {
        // recorded on the run; one connection's failure never stops the others
      }
    }
    return n;
  }

  async list(propertyId: string, channel: string) {
    const conn = await this.db.selectFrom('channelConnections').select('id').where('propertyId', '=', propertyId).where('channel', '=', channel).executeTakeFirst();
    if (!conn) throw new NotFoundError('Channel connection', channel);
    const [runs, issues] = await Promise.all([
      this.db.selectFrom('reconciliationRuns').selectAll().where('connectionId', '=', conn.id).orderBy('startedAt', 'desc').limit(10).execute(),
      this.db.selectFrom('reconciliationIssues').selectAll().where('connectionId', '=', conn.id).where('propertyId', '=', propertyId).where('status', '=', ReconciliationIssueStatus.OPEN).orderBy('createdAt', 'desc').limit(200).execute(),
    ]);
    return { runs, issues };
  }

  async resolve(user: AuthUser, meta: RequestMeta, propertyId: string, issueId: string, status: ReconciliationIssueStatus.RESOLVED | ReconciliationIssueStatus.IGNORED, resolution: string) {
    const row = await this.db
      .updateTable('reconciliationIssues')
      .set({ status, resolution: resolution.slice(0, 500), resolvedBy: user.userId, resolvedAt: new Date() })
      .where('id', '=', issueId)
      .where('propertyId', '=', propertyId)
      .where('status', '=', ReconciliationIssueStatus.OPEN)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Open reconciliation issue', issueId);
    await this.audit.log({ user, meta }, { action: 'channel.reconcile_issue_resolve', entityType: 'ReconciliationIssue', entityId: issueId, propertyId, after: { status, resolution: row.resolution } });
    return row;
  }

  // ------------------------------------------------------------ helpers

  private compare(remote: NormalizedReservationEvent, local: { id: string; status: string; checkIn: Date | string; checkOut: Date | string }): Found[] {
    const out: Found[] = [];
    const remoteActive = remote.kind !== 'RESERVATION_CANCELLED';
    const localActive = ACTIVE.has(local.status);
    const base = { externalReservationId: remote.externalReservationId, reservationId: local.id };
    if (remoteActive !== localActive && !(local.status === ReservationStatus.CHECKED_OUT || local.status === ReservationStatus.NO_SHOW)) {
      out.push({ ...base, kind: ReconciliationIssueKind.STATUS_MISMATCH, details: { remote: remoteActive ? 'ACTIVE' : 'CANCELLED', local: local.status } });
    } else if (remoteActive && localActive) {
      const ci = String(local.checkIn instanceof Date ? local.checkIn.toISOString() : local.checkIn).slice(0, 10);
      const co = String(local.checkOut instanceof Date ? local.checkOut.toISOString() : local.checkOut).slice(0, 10);
      if (ci !== remote.checkIn || co !== remote.checkOut) out.push({ ...base, kind: ReconciliationIssueKind.DATE_MISMATCH, details: { remote: { checkIn: remote.checkIn, checkOut: remote.checkOut }, local: { checkIn: ci, checkOut: co } } });
    }
    return out;
  }

  /** Records what was found, keeps one OPEN issue per (kind, reservation), and closes issues that are no longer true. */
  private async persist(runId: string, connectionId: string, propertyId: string, found: Found[]): Promise<number> {
    const open = await this.db.selectFrom('reconciliationIssues').selectAll().where('connectionId', '=', connectionId).where('status', '=', ReconciliationIssueStatus.OPEN).execute();
    const key = (kind: string, ext: string | null, rid: string | null) => `${kind}|${ext ?? ''}|${rid ?? ''}`;
    const openBy = new Map(open.map((o) => [key(o.kind, o.externalReservationId, o.reservationId), o]));
    const seen = new Set<string>();
    for (const f of found) {
      const k = key(f.kind, f.externalReservationId, f.reservationId ?? null);
      if (seen.has(k)) continue;
      seen.add(k);
      const existing = openBy.get(k);
      if (existing) await this.db.updateTable('reconciliationIssues').set({ runId, details: j(f.details) }).where('id', '=', existing.id).execute();
      else await this.db.insertInto('reconciliationIssues').values({ runId, connectionId, propertyId, kind: f.kind, externalReservationId: f.externalReservationId, reservationId: f.reservationId ?? null, details: j(f.details) }).execute();
    }
    for (const o of open) {
      if (!seen.has(key(o.kind, o.externalReservationId, o.reservationId))) {
        await this.db.updateTable('reconciliationIssues').set({ status: ReconciliationIssueStatus.RESOLVED, resolution: 'No longer detected by a later reconciliation', resolvedAt: new Date() }).where('id', '=', o.id).execute();
      }
    }
    return seen.size;
  }

  private summary(runId: string) {
    return this.db.selectFrom('reconciliationRuns').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
  }
}
