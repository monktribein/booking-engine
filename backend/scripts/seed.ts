/**
 * Seeds the "Tirvona Demo" organization with the Radha Ashram property.
 *
 *   DATABASE_URL=... npm run db:seed            # applies migrations, refuses if the demo org already exists
 *   DATABASE_URL=... npm run db:seed:reset      # EMPTIES every table first (never in production)
 *
 * Every reservation, block and restriction goes through the real services, so
 * the seeded inventory counters are consistent by construction.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { addDays, formatDateOnly, todayIn } from '../src/database/common/dates';
import { hashPassword } from '../src/database/common/crypto';
import { fromMajor } from '../src/database/common/money';
import {
  CancellationPenaltyType,
  ChannelCode,
  ChannelConnectionStatus,
  ChannelKind,
  InventoryBlockReason,
  MarketplaceStatus,
  MarkupType,
  MealPlan,
  OrganizationStatus,
  PaymentProvider,
  PaymentStatus,
  PropertyStatus,
  PropertyUserRole,
  RatePlanType,
  ReservationSource,
  ReservationStatus,
  UserRole,
  UserStatus,
} from '../src/database/enums';
import { Db, createDb, createPool, j } from '../src/database/kysely';
import { migrate } from '../src/database/migrate';
import { Services, createServices } from '../src/database/services';

const TZ = 'Asia/Kolkata';
const ORG_SLUG = 'tirvona-demo';

export interface SeedResult {
  organizationId: string;
  propertyId: string;
  ownerId: string;
  roomTypes: Record<'deluxe' | 'standard' | 'family', string>;
  ratePlans: Record<string, string>;
  rooms: Record<string, string>;
  today: Date;
  ownerPassword: string;
}

export async function seed(db: Db, svc: Services = createServices(db)): Promise<SeedResult> {
  const today = todayIn(TZ);
  const d = (n: number) => addDays(today, n);

  // ------------------------------------------------------------ channels (reference data, upserted)
  const channelDefs = [
    { code: ChannelCode.TIRVONA, name: 'Tirvona', kind: ChannelKind.MARKETPLACE, caps: [true, true, true, true, false] },
    { code: ChannelCode.DIRECT, name: 'Direct Website', kind: ChannelKind.DIRECT, caps: [true, true, true, true, false] },
    { code: ChannelCode.AIRBNB, name: 'Airbnb', kind: ChannelKind.OTA, caps: [true, true, true, true, true] },
    { code: ChannelCode.BOOKING_COM, name: 'Booking.com', kind: ChannelKind.OTA, caps: [true, true, true, true, true] },
    { code: ChannelCode.AGODA, name: 'Agoda', kind: ChannelKind.OTA, caps: [true, true, true, true, true] },
    { code: ChannelCode.OTHER, name: 'Other', kind: ChannelKind.OTA, caps: [false, false, false, true, false] },
  ];
  for (const c of channelDefs) {
    const [availability, rates, restrictions, reservations, webhooks] = c.caps;
    const capabilities = j({ availability, rates, restrictions, reservations, webhooks });
    await db
      .insertInto('channels')
      .values({ code: c.code, name: c.name, kind: c.kind, capabilities })
      .onConflict((oc) => oc.column('code').doUpdateSet({ name: c.name, kind: c.kind, capabilities }))
      .execute();
  }

  // ------------------------------------------------------------ organization, users
  const org = await db.insertInto('organizations').values({ name: 'Tirvona Demo', slug: ORG_SLUG, status: OrganizationStatus.ACTIVE, approvedAt: new Date() }).returningAll().executeTakeFirstOrThrow();
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? randomBytes(12).toString('base64url');
  const owner = await db
    .insertInto('users')
    .values({
      organizationId: org.id,
      name: 'Demo Owner',
      email: 'owner@tirvona.demo',
      phone: '+919800000001',
      passwordHash: await hashPassword(ownerPassword),
      role: UserRole.PROPERTY_OWNER,
      status: UserStatus.ACTIVE,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const reception = await db
    .insertInto('users')
    .values({
      organizationId: org.id,
      name: 'Front Desk',
      email: 'reception@tirvona.demo',
      phone: '+919800000002',
      passwordHash: await hashPassword(randomBytes(12).toString('base64url')),
      role: UserRole.RECEPTION,
      status: UserStatus.INVITED,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // A platform administrator, only when asked for (SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD). The local sandbox asks for one; seeding a
  // real database should not create an account with a password you did not choose: use `npm run admin:create:dev` there.
  if (process.env.SEED_ADMIN_EMAIL) {
    if (!process.env.SEED_ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD.length < 12) throw new Error('SEED_ADMIN_PASSWORD (12+ characters) is required with SEED_ADMIN_EMAIL');
    await db
      .insertInto('users')
      .values({ organizationId: null, name: 'Platform Admin', email: process.env.SEED_ADMIN_EMAIL.toLowerCase(), phone: null, passwordHash: await hashPassword(process.env.SEED_ADMIN_PASSWORD), role: UserRole.SUPER_ADMIN, status: UserStatus.ACTIVE })
      .execute();
  }

  // ------------------------------------------------------------ property
  const property = await db
    .insertInto('properties')
    .values({
      organizationId: org.id,
      ownerId: owner.id,
      name: 'Radha Ashram',
      slug: 'radha-ashram',
      description: 'A quiet ashram-style guest house near the Parikrama Marg, a short walk from the temples of Vrindavan.',
      address: 'Parikrama Marg, Raman Reti',
      city: 'Vrindavan',
      state: 'Uttar Pradesh',
      country: 'IN',
      postalCode: '281121',
      latitude: 27.5705,
      longitude: 77.6593,
      timezone: TZ,
      currency: 'INR',
      checkInTime: '12:00',
      checkOutTime: '10:00',
      taxPercent: 5, // demo value only; real rates come from the property's tax configuration
      bookingHorizonDays: 30, // demo: 30 days of inventory
      amenities: ['wifi', 'parking', 'vegetarian-kitchen', 'temple-shuttle', 'power-backup'],
      images: j([{ url: 'https://images.tirvona.example/radha-ashram/facade.jpg', caption: 'Entrance', sortOrder: 0 }]),
      status: PropertyStatus.ACTIVE,
      // The demo is published on its own page and approved on the marketplace (owner consent recorded).
      directBookingEnabled: true,
      marketplaceStatus: MarketplaceStatus.APPROVED,
      marketplaceConsentAt: new Date(),
      marketplaceConsentBy: owner.id,
      marketplaceReviewedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const pid = property.id;
  await db
    .insertInto('propertyUsers')
    .values([
      { propertyId: pid, userId: owner.id, role: PropertyUserRole.PROPERTY_OWNER },
      { propertyId: pid, userId: reception.id, role: PropertyUserRole.RECEPTION },
    ])
    .execute();

  // ------------------------------------------------------------ room types & physical rooms
  const typeDefs = [
    { key: 'standard', name: 'Standard', slug: 'standard', occ: 2, price: 2000, floor: '1', amen: ['fan', 'hot-water'] },
    { key: 'deluxe', name: 'Deluxe AC', slug: 'deluxe-ac', occ: 3, price: 3500, floor: '2', amen: ['air-conditioning', 'hot-water', 'tv'] },
    { key: 'family', name: 'Family', slug: 'family', occ: 5, price: 5500, floor: '3', amen: ['air-conditioning', 'hot-water', 'tv', 'sofa-bed'] },
  ] as const;

  const roomTypes = {} as SeedResult['roomTypes'];
  const rooms: Record<string, string> = {};
  for (const [i, t] of typeDefs.entries()) {
    const rt = await db
      .insertInto('roomTypes')
      .values({
        propertyId: pid,
        name: t.name,
        slug: t.slug,
        description: `${t.name} room at Radha Ashram`,
        maxOccupancy: t.occ,
        basePrice: fromMajor(t.price),
        currency: 'INR',
        totalRooms: 10,
        amenities: [...t.amen],
        sortOrder: i,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roomTypes[t.key] = rt.id;
    const inserted = await db
      .insertInto('rooms')
      .values(
        Array.from({ length: 10 }, (_, n) => ({
          propertyId: pid,
          roomTypeId: rt.id,
          roomNumber: `${t.floor}${String(n + 1).padStart(2, '0')}`,
          floor: t.floor,
        })),
      )
      .returning(['id', 'roomNumber'])
      .execute();
    for (const room of inserted) rooms[room.roomNumber] = room.id;
  }

  // ------------------------------------------------------------ rate plans (3 per room type)
  const ratePlans: Record<string, string> = {};
  for (const t of typeDefs) {
    const base = fromMajor(t.price);
    const plans = [
      {
        code: 'STD',
        name: 'Standard Flexible',
        type: RatePlanType.STANDARD,
        basePrice: base,
        mealPlan: MealPlan.ROOM_ONLY,
        cancellationPolicy: {
          refundable: true,
          freeCancellationHours: 48,
          penaltyType: CancellationPenaltyType.FIRST_NIGHT,
          description: 'Free cancellation until 48 hours before check-in; after that the first night is charged.',
        },
      },
      {
        code: 'NRF',
        name: 'Non-refundable Saver',
        type: RatePlanType.NON_REFUNDABLE,
        basePrice: Math.round(base * 0.9),
        mealPlan: MealPlan.ROOM_ONLY,
        cancellationPolicy: { refundable: false, penaltyType: CancellationPenaltyType.FULL_STAY, description: 'Non-refundable.' },
      },
      {
        code: 'BB',
        name: 'Bed & Breakfast',
        type: RatePlanType.BREAKFAST,
        basePrice: base + fromMajor(400),
        mealPlan: MealPlan.BREAKFAST,
        cancellationPolicy: {
          refundable: true,
          freeCancellationHours: 24,
          penaltyType: CancellationPenaltyType.PERCENTAGE,
          penaltyValue: 50,
          description: 'Free cancellation until 24 hours before check-in; 50% after that.',
        },
      },
    ];
    for (const p of plans) {
      const rp = await db
        .insertInto('ratePlans')
        .values({
          ...p,
          cancellationPolicy: j({ freeCancellationHours: 0, penaltyValue: 0, ...p.cancellationPolicy }),
          propertyId: pid,
          roomTypeId: roomTypes[t.key],
          currency: 'INR',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ratePlans[`${t.key}.${p.code}`] = rp.id;
    }
  }

  // ------------------------------------------------------------ 30 days of inventory
  for (const rtId of Object.values(roomTypes)) await svc.inventory.ensureInventory(pid, rtId, today, d(30));

  // ------------------------------------------------------------ channel connections, listings, mappings
  const connectionIds: Partial<Record<ChannelCode, string>> = {};
  for (const channel of [ChannelCode.AIRBNB, ChannelCode.BOOKING_COM, ChannelCode.AGODA]) {
    const c = await db
      .insertInto('channelConnections')
      .values({
        propertyId: pid,
        channel,
        status: ChannelConnectionStatus.CONNECTED,
        externalAccountId: `mock-${channel.toLowerCase()}-account`,
        connectedAt: new Date(),
        metadata: j({ mock: true, note: 'Seed data. No real credentials; the sync worker must skip mock connections.' }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    connectionIds[channel] = c.id;
  }

  const airbnb = await svc.channels.upsertListing({
    propertyId: pid,
    channel: ChannelCode.AIRBNB,
    externalListingId: 'mock-airbnb-55010001',
    name: 'Deluxe AC room near Banke Bihari, Radha Ashram',
    channelConnectionId: connectionIds.AIRBNB,
    metadata: { mock: true },
  });
  const bcom = await svc.channels.upsertListing({
    propertyId: pid,
    channel: ChannelCode.BOOKING_COM,
    externalListingId: 'mock-bcom-9900123',
    name: 'Radha Ashram Vrindavan',
    channelConnectionId: connectionIds.BOOKING_COM,
    metadata: { mock: true },
  });
  const agoda = await svc.channels.upsertListing({
    propertyId: pid,
    channel: ChannelCode.AGODA,
    externalListingId: 'mock-agoda-770044',
    name: 'Radha Ashram',
    channelConnectionId: connectionIds.AGODA,
    metadata: { mock: true },
  });

  // Airbnb: one listing = one room type (externalRoomId null).
  const airbnbDlx = await svc.channels.mapRoom({ propertyId: pid, channelListingId: airbnb.id, roomTypeId: roomTypes.deluxe });
  await svc.channels.mapRatePlan({
    propertyId: pid,
    channelRoomMappingId: airbnbDlx.id,
    externalRatePlanId: 'mock-airbnb-default',
    ratePlanId: ratePlans['deluxe.STD'],
    markupType: MarkupType.PERCENTAGE,
    markupValue: 15,
  });

  // Booking.com: one hotel listing holding three room types.
  for (const [key, extRoom] of [
    ['standard', 'mock-bcom-room-std'],
    ['deluxe', 'mock-bcom-room-dlx'],
    ['family', 'mock-bcom-room-fam'],
  ] as const) {
    const map = await svc.channels.mapRoom({ propertyId: pid, channelListingId: bcom.id, roomTypeId: roomTypes[key], externalRoomId: extRoom });
    await svc.channels.mapRatePlan({
      propertyId: pid,
      channelRoomMappingId: map.id,
      externalRatePlanId: `${extRoom}-flex`,
      ratePlanId: ratePlans[`${key}.STD`],
      markupType: MarkupType.PERCENTAGE,
      markupValue: 18,
    });
    await svc.channels.mapRatePlan({
      propertyId: pid,
      channelRoomMappingId: map.id,
      externalRatePlanId: `${extRoom}-nrf`,
      ratePlanId: ratePlans[`${key}.NRF`],
      markupType: MarkupType.PERCENTAGE,
      markupValue: 18,
    });
  }

  // Agoda: Deluxe + Family, breakfast rate with a fixed ₹300 markup. Rates not synced for Family (demo).
  const agodaDlx = await svc.channels.mapRoom({ propertyId: pid, channelListingId: agoda.id, roomTypeId: roomTypes.deluxe, externalRoomId: 'mock-agoda-dlx' });
  await svc.channels.mapRoom({ propertyId: pid, channelListingId: agoda.id, roomTypeId: roomTypes.family, externalRoomId: 'mock-agoda-fam', syncRates: false });
  await svc.channels.mapRatePlan({
    propertyId: pid,
    channelRoomMappingId: agodaDlx.id,
    externalRatePlanId: 'mock-agoda-bb',
    ratePlanId: ratePlans['deluxe.BB'],
    markupType: MarkupType.FIXED,
    markupValue: fromMajor(300),
  });

  // ------------------------------------------------------------ restrictions & a maintenance block
  for (let i = 0; i < 30; i++) {
    const day = d(i).getUTCDay();
    if (day === 5 || day === 6) {
      await svc.inventory.setRestrictions({ propertyId: pid, roomTypeId: roomTypes.family, from: d(i), to: d(i + 1), patch: { minimumStay: 2 }, userId: owner.id });
    }
  }
  await svc.inventory.setRestrictions({ propertyId: pid, roomTypeId: roomTypes.deluxe, from: d(20), to: d(21), patch: { closedToArrival: true }, userId: owner.id });
  await svc.inventory.createBlock({
    propertyId: pid,
    roomTypeId: roomTypes.standard,
    roomId: rooms['110'],
    startDate: d(3),
    endDate: d(6),
    reason: InventoryBlockReason.MAINTENANCE,
    notes: 'Bathroom re-tiling',
    createdBy: owner.id,
  });

  // ------------------------------------------------------------ guests
  const guests = await db
    .insertInto('guests')
    .values([
      { propertyId: pid, firstName: 'Priya', lastName: 'Sharma', email: 'priya.sharma@example.com', phone: '+919811111111', country: 'IN' },
      { propertyId: pid, firstName: 'Arjun', lastName: 'Mehta', email: 'arjun.mehta@example.com', phone: '+919822222222', country: 'IN' },
      { propertyId: pid, firstName: 'Emma', lastName: 'Clarke', email: 'emma.clarke@example.co.uk', phone: null, country: 'GB' },
      { propertyId: pid, firstName: 'Rahul', lastName: 'Verma', email: null, phone: '+919833333333', country: 'IN' },
      { propertyId: pid, firstName: 'Ananya', lastName: 'Iyer', email: 'ananya.iyer@example.com', phone: null, country: 'IN' },
      { propertyId: pid, firstName: 'Kenji', lastName: 'Sato', email: 'kenji.sato@example.jp', phone: null, country: 'JP' },
    ])
    .returning('id')
    .execute();

  // ------------------------------------------------------------ reservations (through the real transactions)
  // 1. Direct website booking: PENDING hold, then a (mock) Razorpay capture confirms it.
  const direct = await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.DIRECT,
    idempotencyKey: 'seed-direct-0001',
    guest: { guestId: guests[0].id },
    checkIn: d(2),
    checkOut: d(4),
    adults: 2,
    rooms: [{ roomTypeId: roomTypes.deluxe, ratePlanId: ratePlans['deluxe.STD'], quantity: 1 }],
  });
  await svc.reservations.recordPayment({
    propertyId: pid,
    reservationId: direct.reservation.id,
    provider: PaymentProvider.RAZORPAY,
    providerOrderId: 'order_mockSEED0001',
    providerPaymentId: 'pay_mockSEED0001',
    amount: direct.reservation.total,
    currency: 'INR',
    status: PaymentStatus.PAID,
    metadata: { method: 'upi', vpa: 'priya@okaxis' },
  });

  // 2. Walk-in, checked into room 101 tonight, paid cash.
  const walkIn = await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.WALK_IN,
    guest: { guestId: guests[3].id },
    checkIn: today,
    checkOut: d(1),
    adults: 1,
    rooms: [{ roomTypeId: roomTypes.standard, ratePlanId: ratePlans['standard.STD'], quantity: 1 }],
    createdBy: reception.id,
  });
  await svc.reservations.assignRoom({
    propertyId: pid,
    reservationId: walkIn.reservation.id,
    reservationRoomId: walkIn.reservation.reservationRooms[0].id,
    roomId: rooms['101'],
    userId: reception.id,
  });
  await svc.reservations.recordPayment({
    propertyId: pid,
    reservationId: walkIn.reservation.id,
    provider: PaymentProvider.CASH,
    amount: walkIn.reservation.total,
    currency: 'INR',
    status: PaymentStatus.PAID,
    createdBy: reception.id,
  });

  // 3. Airbnb booking arriving the production way: webhook inbox → normalised event → reservation.
  const nights = (from: number, to: number, major: number) => Array.from({ length: to - from }, () => fromMajor(major));
  const hook = await svc.webhooks.ingest({
    channel: ChannelCode.AIRBNB,
    eventType: 'reservation.created',
    externalEventId: 'mock-evt-airbnb-0001',
    payload: { mock: true, confirmation_code: 'HMSEED0001' },
    signatureValid: true,
  });
  const airbnbOutcome = await svc.webhooks.applyReservationEvent({
    kind: 'RESERVATION_CREATED',
    channel: ChannelCode.AIRBNB,
    externalListingId: 'mock-airbnb-55010001',
    externalReservationId: 'HMSEED0001',
    checkIn: formatDateOnly(d(5)),
    checkOut: formatDateOnly(d(8)),
    adults: 2,
    guest: { firstName: 'Emma', lastName: 'Clarke', email: 'emma.clarke@example.co.uk' },
    rooms: [{ externalRatePlanId: 'mock-airbnb-default', quantity: 1, nightlyRates: nights(5, 8, 4025) }],
    currency: 'INR',
    paymentCollectedByChannel: true,
  });
  await svc.webhooks.markProcessed(hook.event.id, airbnbOutcome.propertyId);

  // 4. Booking.com: two Family rooms.
  await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.BOOKING_COM,
    externalReservationId: 'BDC-MOCK-4001',
    channelListingId: bcom.id,
    guest: { firstName: 'Kenji', lastName: 'Sato', email: 'kenji.sato@example.jp' },
    checkIn: d(10),
    checkOut: d(13),
    adults: 6,
    children: 2,
    rooms: [{ roomTypeId: roomTypes.family, ratePlanId: ratePlans['family.STD'], quantity: 2, nightlyRates: nights(10, 13, 6490) }],
    paymentCollectedByChannel: false,
  });

  // 5. Phone booking that is then cancelled (inventory goes back).
  const phone = await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.PHONE,
    guest: { guestId: guests[1].id },
    checkIn: d(7),
    checkOut: d(9),
    adults: 2,
    rooms: [{ roomTypeId: roomTypes.standard, ratePlanId: ratePlans['standard.BB'], quantity: 1 }],
    createdBy: reception.id,
  });
  await svc.reservations.cancelReservation({ propertyId: pid, reservationId: phone.reservation.id, reason: 'Guest changed plans', cancelledBy: reception.id });

  // 6. Agoda Deluxe with breakfast.
  await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.AGODA,
    externalReservationId: 'AGD-MOCK-9001',
    channelListingId: agoda.id,
    guest: { guestId: guests[4].id },
    checkIn: d(15),
    checkOut: d(17),
    adults: 2,
    rooms: [{ roomTypeId: roomTypes.deluxe, ratePlanId: ratePlans['deluxe.BB'], quantity: 1, nightlyRates: nights(15, 17, 4200) }],
    paymentCollectedByChannel: true,
  });

  // 7. Tirvona marketplace booking, non-refundable, paid.
  const market = await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.TIRVONA,
    idempotencyKey: 'seed-tirvona-0001',
    guest: { firstName: 'Meera', lastName: 'Nair', email: 'meera.nair@example.com', phone: '+919844444444' },
    checkIn: d(12),
    checkOut: d(14),
    adults: 2,
    rooms: [{ roomTypeId: roomTypes.standard, ratePlanId: ratePlans['standard.NRF'], quantity: 1 }],
  });
  await svc.reservations.recordPayment({
    propertyId: pid,
    reservationId: market.reservation.id,
    provider: PaymentProvider.RAZORPAY,
    providerOrderId: 'order_mockSEED0002',
    providerPaymentId: 'pay_mockSEED0002',
    amount: market.reservation.total,
    currency: 'INR',
    status: PaymentStatus.PAID,
    metadata: { method: 'card', card: { network: 'Visa', last4: '4242' } },
  });

  return { organizationId: org.id, propertyId: pid, ownerId: owner.id, roomTypes, ratePlans, rooms, today, ownerPassword };
}

if (require.main === module) {
  (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const reset = process.argv.includes('--reset');
    if (reset && process.env.NODE_ENV === 'production') throw new Error('Refusing to --reset in production');

    const pool = createPool({ url, ssl: process.env.DATABASE_SSL as 'disable' | 'require' | 'verify-full' | undefined, caCert: process.env.DATABASE_CA_CERT, poolMax: 4, applicationName: 'tirvona-seed' });
    const db = createDb(pool);
    try {
      await migrate(pool, () => undefined);
      if (reset) {
        // TRUNCATE (not DELETE) so the append-only audit trigger does not block it. Migrations bookkeeping is kept.
        const tables = await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`.execute(db);
        await sql`truncate table ${sql.join(tables.rows.map((t) => sql.table(t.tablename)))} restart identity cascade`.execute(db);
        console.log(`emptied ${tables.rows.length} tables`);
      }
      if (await db.selectFrom('organizations').select('id').where('slug', '=', ORG_SLUG).executeTakeFirst()) {
        throw new Error(`"${ORG_SLUG}" is already seeded. Run npm run db:seed:reset to start over.`);
      }
      const res = await seed(db);
      const counts = await Promise.all(
        (['rooms', 'roomTypes', 'ratePlans', 'inventory', 'reservations', 'channelListings', 'channelRoomMappings', 'syncJobs'] as const).map(
          async (t) => `${t}=${(await db.selectFrom(t).select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n}`,
        ),
      );
      console.log(`Seeded Radha Ashram (${res.propertyId}) from ${formatDateOnly(res.today)}: ${counts.join(' ')}`);
      console.log(`Owner login: owner@tirvona.demo / ${process.env.SEED_OWNER_PASSWORD ? '(SEED_OWNER_PASSWORD)' : res.ownerPassword}`);
    } finally {
      await db.destroy();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
