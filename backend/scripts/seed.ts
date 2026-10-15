/**
 * Seeds the "Tirvona Demo" organization with the Radha Ashram property.
 *
 *   MONGODB_URI=... npm run db:seed            # refuses if the demo org already exists
 *   MONGODB_URI=... npm run db:seed:reset      # drops the database first (never in production)
 *
 * Every reservation, block and restriction goes through the real services, so
 * the seeded inventory counters are consistent by construction. Needs a
 * replica set (Atlas, or the docker-compose single-node replica set) because
 * the services use transactions.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import mongoose, { Connection, Types } from 'mongoose';
import { addDays, formatDateOnly, todayIn } from '../src/database/common/dates';
import { hashPassword } from '../src/database/common/crypto';
import { fromMajor } from '../src/database/common/money';
import {
  CancellationPenaltyType,
  ChannelCode,
  ChannelConnectionStatus,
  ChannelKind,
  InventoryBlockReason,
  MarkupType,
  MealPlan,
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
import { getModels } from '../src/database/models';
import { Services, createServices } from '../src/database/services';
import { setupDatabase } from './setup-db';

const TZ = 'Asia/Kolkata';
const ORG_SLUG = 'tirvona-demo';

export interface SeedResult {
  organizationId: Types.ObjectId;
  propertyId: Types.ObjectId;
  ownerId: Types.ObjectId;
  roomTypes: Record<'deluxe' | 'standard' | 'family', Types.ObjectId>;
  ratePlans: Record<string, Types.ObjectId>;
  rooms: Record<string, Types.ObjectId>;
  today: Date;
  ownerPassword: string;
}

export async function seed(conn: Connection, svc: Services = createServices(conn)): Promise<SeedResult> {
  const m = getModels(conn);
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
    await m.Channel.updateOne(
      { code: c.code },
      { $set: { name: c.name, kind: c.kind, capabilities: { availability, rates, restrictions, reservations, webhooks } } },
      { upsert: true },
    );
  }

  // ------------------------------------------------------------ organization, users
  const [org] = await m.Organization.create([{ name: 'Tirvona Demo', slug: ORG_SLUG }]);
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? randomBytes(12).toString('base64url');
  const [owner, reception] = await m.User.create([
    {
      organizationId: org._id,
      name: 'Demo Owner',
      email: 'owner@tirvona.demo',
      phone: '+919800000001',
      passwordHash: await hashPassword(ownerPassword),
      role: UserRole.PROPERTY_OWNER,
      status: UserStatus.ACTIVE,
    },
    {
      organizationId: org._id,
      name: 'Front Desk',
      email: 'reception@tirvona.demo',
      phone: '+919800000002',
      passwordHash: await hashPassword(randomBytes(12).toString('base64url')),
      role: UserRole.RECEPTION,
      status: UserStatus.INVITED,
    },
  ]);

  // ------------------------------------------------------------ property
  const [property] = await m.Property.create([
    {
      organizationId: org._id,
      ownerId: owner._id,
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
      images: [{ url: 'https://images.tirvona.example/radha-ashram/facade.jpg', caption: 'Entrance', sortOrder: 0 }],
      status: PropertyStatus.ACTIVE,
    },
  ]);
  const pid = property._id;
  await m.PropertyUser.create([
    { propertyId: pid, userId: owner._id, role: PropertyUserRole.PROPERTY_OWNER },
    { propertyId: pid, userId: reception._id, role: PropertyUserRole.RECEPTION },
  ]);

  // ------------------------------------------------------------ room types & physical rooms
  const typeDefs = [
    { key: 'standard', name: 'Standard', slug: 'standard', occ: 2, price: 2000, floor: '1', amen: ['fan', 'hot-water'] },
    { key: 'deluxe', name: 'Deluxe AC', slug: 'deluxe-ac', occ: 3, price: 3500, floor: '2', amen: ['air-conditioning', 'hot-water', 'tv'] },
    { key: 'family', name: 'Family', slug: 'family', occ: 5, price: 5500, floor: '3', amen: ['air-conditioning', 'hot-water', 'tv', 'sofa-bed'] },
  ] as const;

  const roomTypes = {} as SeedResult['roomTypes'];
  const rooms: Record<string, Types.ObjectId> = {};
  for (const [i, t] of typeDefs.entries()) {
    const [rt] = await m.RoomType.create([
      {
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
      },
    ]);
    roomTypes[t.key] = rt._id;
    const docs = Array.from({ length: 10 }, (_, n) => ({
      propertyId: pid,
      roomTypeId: rt._id,
      roomNumber: `${t.floor}${String(n + 1).padStart(2, '0')}`,
      floor: t.floor,
    }));
    for (const room of await m.Room.insertMany(docs)) rooms[room.roomNumber] = room._id;
  }

  // ------------------------------------------------------------ rate plans (3 per room type)
  const ratePlans: Record<string, Types.ObjectId> = {};
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
      const [rp] = await m.RatePlan.create([{ ...p, propertyId: pid, roomTypeId: roomTypes[t.key], currency: 'INR' }]);
      ratePlans[`${t.key}.${p.code}`] = rp._id;
    }
  }

  // ------------------------------------------------------------ 30 days of inventory
  for (const rtId of Object.values(roomTypes)) await svc.inventory.ensureInventory(pid, rtId, today, d(30));

  // ------------------------------------------------------------ channel connections, listings, mappings
  const connectionIds: Partial<Record<ChannelCode, Types.ObjectId>> = {};
  for (const channel of [ChannelCode.AIRBNB, ChannelCode.BOOKING_COM, ChannelCode.AGODA]) {
    const [c] = await m.ChannelConnection.create([
      {
        propertyId: pid,
        channel,
        status: ChannelConnectionStatus.CONNECTED,
        externalAccountId: `mock-${channel.toLowerCase()}-account`,
        connectedAt: new Date(),
        metadata: { mock: true, note: 'Seed data. No real credentials; the sync worker must skip mock connections.' },
      },
    ]);
    connectionIds[channel] = c._id;
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
  const airbnbDlx = await svc.channels.mapRoom({ propertyId: pid, channelListingId: airbnb!._id, roomTypeId: roomTypes.deluxe });
  await svc.channels.mapRatePlan({
    propertyId: pid,
    channelRoomMappingId: airbnbDlx._id,
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
    const map = await svc.channels.mapRoom({ propertyId: pid, channelListingId: bcom!._id, roomTypeId: roomTypes[key], externalRoomId: extRoom });
    await svc.channels.mapRatePlan({
      propertyId: pid,
      channelRoomMappingId: map._id,
      externalRatePlanId: `${extRoom}-flex`,
      ratePlanId: ratePlans[`${key}.STD`],
      markupType: MarkupType.PERCENTAGE,
      markupValue: 18,
    });
    await svc.channels.mapRatePlan({
      propertyId: pid,
      channelRoomMappingId: map._id,
      externalRatePlanId: `${extRoom}-nrf`,
      ratePlanId: ratePlans[`${key}.NRF`],
      markupType: MarkupType.PERCENTAGE,
      markupValue: 18,
    });
  }

  // Agoda: Deluxe + Family, breakfast rate with a fixed ₹300 markup. Rates not synced for Family (demo).
  const agodaDlx = await svc.channels.mapRoom({ propertyId: pid, channelListingId: agoda!._id, roomTypeId: roomTypes.deluxe, externalRoomId: 'mock-agoda-dlx' });
  await svc.channels.mapRoom({ propertyId: pid, channelListingId: agoda!._id, roomTypeId: roomTypes.family, externalRoomId: 'mock-agoda-fam', syncRates: false });
  await svc.channels.mapRatePlan({
    propertyId: pid,
    channelRoomMappingId: agodaDlx._id,
    externalRatePlanId: 'mock-agoda-bb',
    ratePlanId: ratePlans['deluxe.BB'],
    markupType: MarkupType.FIXED,
    markupValue: fromMajor(300),
  });

  // ------------------------------------------------------------ restrictions & a maintenance block
  for (let i = 0; i < 30; i++) {
    const day = d(i).getUTCDay();
    if (day === 5 || day === 6) {
      await svc.inventory.setRestrictions({ propertyId: pid, roomTypeId: roomTypes.family, from: d(i), to: d(i + 1), patch: { minimumStay: 2 }, userId: owner._id });
    }
  }
  await svc.inventory.setRestrictions({ propertyId: pid, roomTypeId: roomTypes.deluxe, from: d(20), to: d(21), patch: { closedToArrival: true }, userId: owner._id });
  await svc.inventory.createBlock({
    propertyId: pid,
    roomTypeId: roomTypes.standard,
    roomId: rooms['110'],
    startDate: d(3),
    endDate: d(6),
    reason: InventoryBlockReason.MAINTENANCE,
    notes: 'Bathroom re-tiling',
    createdBy: owner._id,
  });

  // ------------------------------------------------------------ guests
  const guests = await m.Guest.insertMany([
    { propertyId: pid, firstName: 'Priya', lastName: 'Sharma', email: 'priya.sharma@example.com', phone: '+919811111111', country: 'IN' },
    { propertyId: pid, firstName: 'Arjun', lastName: 'Mehta', email: 'arjun.mehta@example.com', phone: '+919822222222', country: 'IN' },
    { propertyId: pid, firstName: 'Emma', lastName: 'Clarke', email: 'emma.clarke@example.co.uk', country: 'GB' },
    { propertyId: pid, firstName: 'Rahul', lastName: 'Verma', phone: '+919833333333', country: 'IN' },
    { propertyId: pid, firstName: 'Ananya', lastName: 'Iyer', email: 'ananya.iyer@example.com', country: 'IN' },
    { propertyId: pid, firstName: 'Kenji', lastName: 'Sato', email: 'kenji.sato@example.jp', country: 'JP' },
  ]);

  // ------------------------------------------------------------ reservations (through the real transactions)
  // 1. Direct website booking: PENDING hold, then a (mock) Razorpay capture confirms it.
  const direct = await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.DIRECT,
    idempotencyKey: 'seed-direct-0001',
    guest: { guestId: guests[0]._id },
    checkIn: d(2),
    checkOut: d(4),
    adults: 2,
    rooms: [{ roomTypeId: roomTypes.deluxe, ratePlanId: ratePlans['deluxe.STD'], quantity: 1 }],
  });
  await svc.reservations.recordPayment({
    propertyId: pid,
    reservationId: direct.reservation._id,
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
    guest: { guestId: guests[3]._id },
    checkIn: today,
    checkOut: d(1),
    adults: 1,
    rooms: [{ roomTypeId: roomTypes.standard, ratePlanId: ratePlans['standard.STD'], quantity: 1 }],
    createdBy: reception._id,
  });
  await svc.reservations.assignRoom({
    propertyId: pid,
    reservationId: walkIn.reservation._id,
    reservationRoomId: walkIn.reservation.reservationRooms[0]._id,
    roomId: rooms['101'],
    userId: reception._id,
  });
  await svc.reservations.recordPayment({
    propertyId: pid,
    reservationId: walkIn.reservation._id,
    provider: PaymentProvider.CASH,
    amount: walkIn.reservation.total,
    currency: 'INR',
    status: PaymentStatus.PAID,
    createdBy: reception._id,
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
  await svc.webhooks.markProcessed(hook.event._id, airbnbOutcome.propertyId);

  // 4. Booking.com: two Family rooms.
  await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.BOOKING_COM,
    externalReservationId: 'BDC-MOCK-4001',
    channelListingId: bcom!._id,
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
    guest: { guestId: guests[1]._id },
    checkIn: d(7),
    checkOut: d(9),
    adults: 2,
    rooms: [{ roomTypeId: roomTypes.standard, ratePlanId: ratePlans['standard.BB'], quantity: 1 }],
    createdBy: reception._id,
  });
  await svc.reservations.cancelReservation({ propertyId: pid, reservationId: phone.reservation._id, reason: 'Guest changed plans', cancelledBy: reception._id });

  // 6. Agoda Deluxe with breakfast.
  await svc.reservations.createReservation({
    propertyId: pid,
    source: ReservationSource.AGODA,
    externalReservationId: 'AGD-MOCK-9001',
    channelListingId: agoda!._id,
    guest: { guestId: guests[4]._id },
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
    reservationId: market.reservation._id,
    provider: PaymentProvider.RAZORPAY,
    providerOrderId: 'order_mockSEED0002',
    providerPaymentId: 'pay_mockSEED0002',
    amount: market.reservation.total,
    currency: 'INR',
    status: PaymentStatus.PAID,
    metadata: { method: 'card', card: { network: 'Visa', last4: '4242' } },
  });

  return { organizationId: org._id, propertyId: pid, ownerId: owner._id, roomTypes, ratePlans, rooms, today, ownerPassword };
}

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    const reset = process.argv.includes('--reset');
    if (reset && process.env.NODE_ENV === 'production') throw new Error('Refusing to --reset in production');

    const conn = await mongoose.createConnection(uri, { dbName: process.env.MONGODB_DB ?? 'tirvona', autoIndex: false, autoCreate: false }).asPromise();
    try {
      if (reset) {
        await conn.dropDatabase();
        console.log(`dropped ${conn.name}`);
      }
      await setupDatabase(conn, { log: () => undefined });
      if (await getModels(conn).Organization.exists({ slug: ORG_SLUG })) {
        throw new Error(`"${ORG_SLUG}" is already seeded. Run npm run db:seed:reset to start over.`);
      }
      const res = await seed(conn);
      const m = getModels(conn);
      const counts = await Promise.all(
        (['Room', 'RoomType', 'RatePlan', 'Inventory', 'Reservation', 'ChannelListing', 'ChannelRoomMapping', 'SyncJob'] as const).map(
          async (k) => `${k}=${await (m[k] as mongoose.Model<unknown>).countDocuments()}`,
        ),
      );
      console.log(`Seeded Radha Ashram (${res.propertyId}) from ${formatDateOnly(res.today)}: ${counts.join(' ')}`);
      console.log(`Owner login: owner@tirvona.demo / ${process.env.SEED_OWNER_PASSWORD ? '(SEED_OWNER_PASSWORD)' : res.ownerPassword}`);
    } finally {
      await conn.close();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
