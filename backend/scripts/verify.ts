/**
 * End-to-end verification against a throwaway PostgreSQL server (the official binaries via `embedded-postgres`).
 * Seeds Radha Ashram, then hammers the concurrency guarantees:
 *
 *   npm run db:verify
 */
import { sql } from 'kysely';
import { addDays, eachNight, formatDateOnly, localDateTimeToInstant } from '../src/database/common/dates';
import { ChannelCode, InventoryBlockReason, ReservationSource, ReservationStatus, SyncJobStatus } from '../src/database/enums';
import { DomainError } from '../src/database/errors';
import { createDb, createPool } from '../src/database/kysely';
import { migrate } from '../src/database/migrate';
import { findReservation } from '../src/database/reservation-store';
import { createServices } from '../src/database/services';
import { d } from '../src/database/sql';
import { startEphemeralPg } from './embedded-pg';
import { seed } from './seed';

let failures = 0;
function check(cond: unknown, label: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

const pgCode = (e: unknown) => (e as { code?: string } | null)?.code;

async function main() {
  const server = await startEphemeralPg();
  const url = await server.createDatabase('tirvona_verify');
  const pool = createPool({ url, ssl: 'disable', poolMax: 30 });
  const db = createDb(pool);
  try {
    await migrate(pool, () => undefined);
    const svc = createServices(db);
    const s = await seed(db, svc);
    const pid = s.propertyId;
    const day = (n: number) => addDays(s.today, n);
    const inv = (rt: string, date: Date) => db.selectFrom('inventory').selectAll().where('propertyId', '=', pid).where('roomTypeId', '=', rt).where('date', '=', d(date)).executeTakeFirst();
    const count = async (table: 'rooms' | 'inventory' | 'syncJobs' | 'notifications' | 'reservations', where?: (q: any) => any) => {
      let q = db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n'));
      if (where) q = where(q);
      return Number((await q.executeTakeFirstOrThrow()).n);
    };

    // ---------------------------------------------------------------- seed sanity
    check((await count('rooms', (q) => q.where('propertyId', '=', pid))) === 30, 'seed: 30 physical rooms');
    check((await count('inventory', (q) => q.where('propertyId', '=', pid))) === 90, 'seed: 30 days x 3 room types of inventory');
    const dlxDay2 = await inv(s.roomTypes.deluxe, day(2));
    check(dlxDay2?.sold === 1 && dlxDay2.available === 9, 'seed: direct booking decremented Deluxe on day 2');
    const stdDay7 = await inv(s.roomTypes.standard, day(7));
    check(stdDay7?.sold === 0 && stdDay7.available === 10, 'seed: cancelled phone booking released Standard on day 7');
    const stdDay4 = await inv(s.roomTypes.standard, day(4));
    check(stdDay4?.blocked === 1 && stdDay4.available === 9, 'seed: maintenance block on room 110 counted');
    const direct = await db.selectFrom('reservations').selectAll().where('idempotencyKey', '=', 'seed-direct-0001').executeTakeFirst();
    check(direct?.status === ReservationStatus.CONFIRMED && direct.paymentStatus === 'PAID', 'seed: Razorpay payment confirmed PENDING direct booking');
    check((await count('syncJobs', (q) => q.where('status', '=', SyncJobStatus.PENDING))) > 0, 'seed: outbox sync jobs queued for connected channels');

    // ---------------------------------------------------------------- 1. double booking: last room, 25 concurrent requests
    const night = day(25);
    const before = (await inv(s.roomTypes.deluxe, night))!;
    await svc.inventory.createBlock({
      propertyId: pid,
      roomTypeId: s.roomTypes.deluxe,
      startDate: night,
      endDate: addDays(night, 1),
      quantity: before.available - 1,
      reason: InventoryBlockReason.OWNER_BLOCK,
    });
    check((await inv(s.roomTypes.deluxe, night))!.available === 1, 'setup: exactly 1 Deluxe room left on day 25');

    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        svc.reservations.createReservation({
          propertyId: pid,
          source: ReservationSource.DIRECT,
          idempotencyKey: `race-${i}`,
          guest: { firstName: 'Race', lastName: `Guest ${i}`, email: `race${i}@example.com` },
          checkIn: night,
          checkOut: addDays(night, 1),
          adults: 1,
          rooms: [{ roomTypeId: s.roomTypes.deluxe, ratePlanId: s.ratePlans['deluxe.STD'], quantity: 1 }],
        }),
      ),
    );
    const won = attempts.filter((a) => a.status === 'fulfilled').length;
    const soldOut = attempts.filter((a) => a.status === 'rejected' && (a.reason as DomainError).code === 'ROOM_NOT_AVAILABLE').length;
    const after = (await inv(s.roomTypes.deluxe, night))!;
    check(won === 1 && soldOut === 24, `double booking: 25 concurrent requests → ${won} booked, ${soldOut} sold out`);
    check(after.available === 0 && after.sold === before.sold + 1, 'double booking: available=0, sold incremented exactly once');

    // ---------------------------------------------------------------- 2. multi-night all-or-nothing
    const fam = s.roomTypes.family;
    const [n1, n2, n3] = [day(21), day(22), day(23)];
    const famMidBefore = (await inv(fam, n2))!;
    await svc.inventory.createBlock({ propertyId: pid, roomTypeId: fam, startDate: n2, endDate: n3, quantity: famMidBefore.available, reason: InventoryBlockReason.PRIVATE_EVENT });
    const n1Before = (await inv(fam, n1))!;
    const multi = await svc.reservations
      .createReservation({
        propertyId: pid,
        source: ReservationSource.PHONE,
        guest: { firstName: 'Multi', lastName: 'Night' },
        checkIn: n1,
        checkOut: addDays(n3, 1),
        adults: 2,
        rooms: [{ roomTypeId: fam, ratePlanId: s.ratePlans['family.STD'], quantity: 1 }],
      })
      .then(() => null, (e: DomainError) => e);
    const n1After = (await inv(fam, n1))!;
    check(multi?.code === 'ROOM_NOT_AVAILABLE', 'multi-night: sold-out middle night rejects the stay');
    check(n1After.available === n1Before.available && n1After.sold === n1Before.sold, 'multi-night: first night rolled back (no partial decrement)');

    // ---------------------------------------------------------------- 3. duplicate OTA deliveries
    const dupInput = {
      propertyId: pid,
      source: ReservationSource.AIRBNB,
      externalReservationId: 'HM-DUP-777',
      guest: { firstName: 'Dup', lastName: 'Guest' },
      checkIn: day(18),
      checkOut: day(19),
      adults: 2,
      rooms: [{ roomTypeId: s.roomTypes.standard, quantity: 1, nightlyRates: [250000] }],
      paymentCollectedByChannel: true,
    };
    const stdBefore = (await inv(s.roomTypes.standard, day(18)))!;
    const dups = await Promise.all(Array.from({ length: 6 }, () => svc.reservations.createReservation(dupInput)));
    const ids = new Set(dups.map((r) => r.reservation.id));
    check(ids.size === 1 && dups.filter((r) => r.created).length === 1, 'OTA idempotency: 6 concurrent AIRBNB+HM-DUP-777 → 1 reservation');
    check((await inv(s.roomTypes.standard, day(18)))!.sold === stdBefore.sold + 1, 'OTA idempotency: inventory decremented once');

    // ---------------------------------------------------------------- 4. webhook idempotency
    const w1 = await svc.webhooks.ingest({ channel: ChannelCode.BOOKING_COM, eventType: 'reservation.created', externalEventId: 'evt-42', payload: { a: 1 }, signatureValid: true });
    const w2 = await svc.webhooks.ingest({ channel: ChannelCode.BOOKING_COM, eventType: 'reservation.created', externalEventId: 'evt-42', payload: { a: 1 }, signatureValid: true });
    check(!w1.duplicate && w2.duplicate && w1.event.id === w2.event.id, 'webhook: redelivery of BOOKING_COM evt-42 detected');
    const w3 = await svc.webhooks.ingest({ channel: ChannelCode.AGODA, eventType: 'x', payload: { same: 'body' }, signatureValid: true });
    const w4 = await svc.webhooks.ingest({ channel: ChannelCode.AGODA, eventType: 'x', payload: { same: 'body' }, signatureValid: true });
    check(w4.duplicate && w3.event.id === w4.event.id, 'webhook: events without an ID dedupe on body hash');

    // ---------------------------------------------------------------- 5. cancellation: concurrent cancels release once
    const toCancel = dups[0].reservation;
    const stdMid = (await inv(s.roomTypes.standard, day(18)))!;
    const cancels = await Promise.allSettled(Array.from({ length: 5 }, () => svc.reservations.cancelReservation({ propertyId: pid, reservationId: toCancel.id, reason: 'test' })));
    const effective = cancels.filter((c) => c.status === 'fulfilled' && !c.value.alreadyCancelled).length;
    const stdAfterCancel = (await inv(s.roomTypes.standard, day(18)))!;
    check(effective === 1 && cancels.every((c) => c.status === 'fulfilled'), `cancellation: 5 concurrent cancels → ${effective} effective, rest no-op`);
    check(stdAfterCancel.sold === stdMid.sold - 1 && stdAfterCancel.available === stdMid.available + 1, 'cancellation: inventory released exactly once');

    // ---------------------------------------------------------------- 6. database constraints
    const bad = await db
      .updateTable('inventory')
      .set({ available: -1 })
      .where('propertyId', '=', pid)
      .where('roomTypeId', '=', s.roomTypes.standard)
      .where('date', '=', d(day(1)))
      .execute()
      .then(() => null, (e: unknown) => e);
    check(pgCode(bad) === '23514', 'constraint: raw write of available=-1 rejected by PostgreSQL (23514)');
    const drift = await db
      .updateTable('inventory')
      .set({ sold: sql<number>`sold + 1` })
      .where('propertyId', '=', pid)
      .where('roomTypeId', '=', s.roomTypes.standard)
      .where('date', '=', d(day(1)))
      .execute()
      .then(() => null, (e: unknown) => e);
    check(pgCode(drift) === '23514', 'constraint: raw write breaking available+sold+blocked=total+overbooked rejected');

    // ---------------------------------------------------------------- 7. historical prices are frozen
    const priced = (await db.selectFrom('reservations').selectAll().where('idempotencyKey', '=', 'seed-direct-0001').executeTakeFirstOrThrow())!;
    await db.updateTable('ratePlans').set({ basePrice: 999900 }).where('id', '=', s.ratePlans['deluxe.STD']).execute();
    const reread = (await findReservation(db, { id: priced.id }))!;
    check(
      reread.reservationRooms[0].nightlyRates.every((r) => r.amount === 350000) && reread.total === priced.total,
      'history: rate plan price change does not alter existing reservation',
    );
    await db.updateTable('ratePlans').set({ basePrice: 350000 }).where('id', '=', s.ratePlans['deluxe.STD']).execute();

    // ---------------------------------------------------------------- 8. room assignment race
    const mk = (i: number) =>
      svc.reservations.createReservation({
        propertyId: pid,
        source: ReservationSource.PHONE,
        guest: { firstName: 'Assign', lastName: String(i) },
        checkIn: day(9),
        checkOut: day(11),
        adults: 1,
        rooms: [{ roomTypeId: s.roomTypes.standard, ratePlanId: s.ratePlans['standard.STD'], quantity: 1 }],
      });
    const [a, b] = [await mk(1), await mk(2)];
    const assigns = await Promise.allSettled(
      [a, b].map((r) => svc.reservations.assignRoom({ propertyId: pid, reservationId: r.reservation.id, reservationRoomId: r.reservation.reservationRooms[0].id, roomId: s.rooms['105'] })),
    );
    check(
      assigns.filter((x) => x.status === 'fulfilled').length === 1 && assigns.some((x) => x.status === 'rejected' && (x.reason as DomainError).code === 'ROOM_ASSIGNMENT_CONFLICT'),
      'room assignment: two overlapping stays racing for room 105 → exactly one wins',
    );
    const blockedRoom = await svc.reservations
      .assignRoom({ propertyId: pid, reservationId: a.reservation.id, reservationRoomId: a.reservation.reservationRooms[0].id, roomId: s.rooms['110'] })
      .then(() => null, (e: DomainError) => e);
    check(blockedRoom === null, 'room assignment: room 110 is free on days 9-10 (its block is days 3-5)');

    // ---------------------------------------------------------------- 9. OTA overbooking is recorded, never negative
    const ob = await svc.reservations.createReservation({
      propertyId: pid,
      source: ReservationSource.BOOKING_COM,
      externalReservationId: 'BDC-OVERBOOK-1',
      guest: { firstName: 'Late', lastName: 'Sync' },
      checkIn: n2,
      checkOut: n3,
      adults: 2,
      rooms: [{ roomTypeId: fam, quantity: 1, nightlyRates: [650000] }],
      paymentCollectedByChannel: true,
    });
    const famN2 = (await inv(fam, n2))!;
    check(ob.reservation.overbooked && famN2.available === 0 && famN2.overbooked === 1, 'overbooking: OTA booking on 0 availability → overbooked=1, available stays 0');
    check((await count('notifications', (q) => q.where('type', '=', 'OVERBOOKING_ALERT'))) === 1, 'overbooking: owner alert queued');
    await svc.reservations.cancelReservation({ propertyId: pid, reservationId: ob.reservation.id, reason: 'relocated' });
    const famN2b = (await inv(fam, n2))!;
    check(famN2b.overbooked === 0 && famN2b.available === 0, 'overbooking: cancelling clears overbooked before freeing rooms');

    // ---------------------------------------------------------------- 10. restrictions
    const cta = await svc.reservations
      .createReservation({
        propertyId: pid,
        source: ReservationSource.DIRECT,
        guest: { firstName: 'CTA', lastName: 'Test' },
        checkIn: day(20),
        checkOut: day(22),
        adults: 1,
        rooms: [{ roomTypeId: s.roomTypes.deluxe, ratePlanId: s.ratePlans['deluxe.STD'], quantity: 1 }],
      })
      .then(() => null, (e: DomainError) => e);
    check(cta?.code === 'RESTRICTION_VIOLATION', 'restrictions: closed-to-arrival on day 20 enforced');

    // ---------------------------------------------------------------- 11. availability + calendar
    const avail = await svc.availability.search({ propertyId: pid, checkIn: formatDateOnly(day(25)), checkOut: formatDateOnly(day(26)), adults: 2 });
    const dlx = avail.find((x) => x.roomTypeId === s.roomTypes.deluxe);
    const std = avail.find((x) => x.roomTypeId === s.roomTypes.standard);
    check(avail.length === 3 && dlx && !dlx.bookable && dlx.availableUnits === 0, 'availability: sold-out Deluxe on day 25 not bookable');
    check(!!std?.bookable && std.ratePlans.length === 3 && std.ratePlans[0].code === 'NRF', 'availability: Standard bookable with 3 priced rate plans');
    const beyond = await svc.availability.search({ propertyId: pid, checkIn: formatDateOnly(day(29)), checkOut: formatDateOnly(day(31)), adults: 1 });
    check(beyond.length === 0, 'availability: stays past the 30-day horizon return nothing');

    const cal = await svc.calendar.getCalendar(pid, s.today, day(14));
    check(cal.roomTypes.length === 3 && cal.roomTypes.every((r) => r.days.length === 14), 'calendar: 3 room types × 14 days');
    check(cal.reservations.length >= 5 && cal.blocks.length >= 1, `calendar: ${cal.reservations.length} reservations, ${cal.blocks.length} blocks overlap`);

    // ---------------------------------------------------------------- 12. hold expiry
    const hold = await svc.reservations.createReservation({
      propertyId: pid,
      source: ReservationSource.DIRECT,
      guest: { firstName: 'Slow', lastName: 'Payer' },
      checkIn: day(26),
      checkOut: day(28), // 2 nights: satisfies the weekend min-stay on Family whatever today is
      adults: 1,
      rooms: [{ roomTypeId: s.roomTypes.family, ratePlanId: s.ratePlans['family.NRF'], quantity: 1 }],
    });
    const famHeld = (await inv(fam, day(26)))!;
    const expired = await svc.reservations.expirePendingHolds(new Date(Date.now() + 60 * 60_000));
    const famFreed = (await inv(fam, day(26)))!;
    const holdAfter = await db.selectFrom('reservations').select('status').where('id', '=', hold.reservation.id).executeTakeFirstOrThrow();
    check(expired >= 1 && holdAfter.status === ReservationStatus.CANCELLED && famFreed.available === famHeld.available + 1, 'holds: expired unpaid booking released');

    // ---------------------------------------------------------------- 13. refunds follow the frozen policy
    const refundable = await db.selectFrom('reservations').select(['id', 'total']).where('idempotencyKey', '=', 'seed-direct-0001').executeTakeFirstOrThrow();
    const early = await svc.reservations.cancelReservation({ propertyId: pid, reservationId: refundable.id, reason: 'early cancel', now: localDateTimeToInstant(s.today, '00:00', 'Asia/Kolkata') });
    check(early.refunds.length === 1 && early.refunds[0].amount === refundable.total, 'refunds: cancel >48h before arrival on STD → full refund queued');

    // ---------------------------------------------------------------- 14. channel mapping queries
    const listings = (await svc.channels.listListingsWithMappings(pid)) as { id: string; channel: string; roomMappings: unknown[] }[];
    const bcom = listings.find((l) => l.channel === ChannelCode.BOOKING_COM)!;
    check(listings.length === 3 && bcom.roomMappings.length === 3, 'channels: 3 listings; Booking.com hotel maps 3 room types');
    const inbound = await svc.channels.resolveInboundRoom(ChannelCode.BOOKING_COM, 'mock-bcom-9900123', 'mock-bcom-room-fam');
    check(inbound?.roomTypeId === fam, 'channels: inbound Booking.com room resolves to Family');
    const targets = await svc.channels.getOutboundTargets(pid, s.roomTypes.deluxe);
    check(targets.length === 3, 'channels: Deluxe fans out to Airbnb, Booking.com and Agoda');
    const dupMap = await svc.channels
      .mapRoom({ propertyId: pid, channelListingId: bcom.id, roomTypeId: fam, externalRoomId: 'mock-bcom-room-fam' })
      .then(() => null, (e: DomainError) => e);
    check(dupMap?.code === 'DUPLICATE', 'channels: duplicate room mapping rejected');

    // ---------------------------------------------------------------- 15. sync worker claim is exclusive
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => svc.syncJobs.claimNext(`w${i}`)));
    const claimed = claims.filter(Boolean).map((j) => j!.id);
    check(new Set(claimed).size === claimed.length, 'sync jobs: 10 concurrent workers never claim the same job');

    // ---------------------------------------------------------------- 16. secrets never persisted in logs
    await svc.syncJobs.log({
      propertyId: pid,
      channel: ChannelCode.AIRBNB,
      action: 'push_availability',
      status: 'SUCCESS' as never,
      requestMetadata: { headers: { Authorization: 'Bearer SECRET-XYZ', 'X-Api-Key': 'KEY-PLAIN-9' }, accessToken: 'TOK-PLAIN-123', body: { card: '4111 1111 1111 1111' } },
      duration: 12,
    });
    const log = await db.selectFrom('syncLogs').selectAll().where('action', '=', 'push_availability').executeTakeFirst();
    check(!/SECRET-XYZ|KEY-PLAIN-9|TOK-PLAIN-123|4111/.test(JSON.stringify(log)), 'sync logs: Authorization, tokens and card numbers redacted');

    // ---------------------------------------------------------------- invariant sweep
    const broken = await count('inventory', (q) => q.where(sql<boolean>`available + sold + blocked <> total + overbooked`));
    const negative = await count('inventory', (q) => q.where(sql<boolean>`available < 0 or sold < 0 or blocked < 0`));
    check(broken === 0 && negative === 0, 'invariant: every inventory row balanced, nothing negative');

    // Inventory sold must equal active reservations per night (ground truth recount).
    // A reservation holds [checkIn, min(checkOut, inventoryReleasedFrom)) whatever its status.
    const resRows = await db.selectFrom('reservations').selectAll().where('propertyId', '=', pid).execute();
    const lines = await db.selectFrom('reservationRooms').select(['reservationId', 'roomTypeId', 'quantity']).where('reservationId', 'in', resRows.map((r) => r.id)).execute();
    const expectedSold = new Map<string, number>();
    for (const r of resRows) {
      const end = r.inventoryReleasedFrom && r.inventoryReleasedFrom < r.checkOut ? r.inventoryReleasedFrom : r.checkOut;
      for (const line of lines.filter((l) => l.reservationId === r.id))
        for (const nightDate of eachNight(r.checkIn, end)) {
          const k = `${line.roomTypeId}|${formatDateOnly(nightDate)}`;
          expectedSold.set(k, (expectedSold.get(k) ?? 0) + line.quantity);
        }
    }
    const rows = await db.selectFrom('inventory').selectAll().where('propertyId', '=', pid).execute();
    const mismatches = rows.filter((row) => row.sold !== (expectedSold.get(`${row.roomTypeId}|${formatDateOnly(row.date)}`) ?? 0));
    check(mismatches.length === 0, `recount: inventory.sold matches active reservations on all ${rows.length} rows`);

    // ---------------------------------------------------------------- index usage (planner forced off sequential scans)
    const explain = async (query: string, params: unknown[]) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local enable_seqscan = off');
        const res = await client.query(`explain (format json) ${query}`, params);
        await client.query('rollback');
        return JSON.stringify(res.rows[0]['QUERY PLAN']);
      } finally {
        client.release();
      }
    };
    const invPlan = await explain('select * from inventory where property_id = $1 and room_type_id = $2 and date >= $3::date and date < $4::date', [pid, fam, formatDateOnly(day(1)), formatDateOnly(day(5))]);
    check(/Index (Only )?Scan|Bitmap Index Scan/.test(invPlan) && !invPlan.includes('Seq Scan'), 'explain: inventory range read uses an index');
    const resPlan = await explain('select * from reservations where property_id = $1 and check_in < $2::date and check_out > $3::date', [pid, formatDateOnly(day(14)), formatDateOnly(s.today)]);
    check(/Index (Only )?Scan|Bitmap Index Scan/.test(resPlan) && !resPlan.includes('Seq Scan'), 'explain: calendar reservation overlap uses an index');
  } finally {
    await db.destroy();
    await server.stop();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
