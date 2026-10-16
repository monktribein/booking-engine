import { randomBytes } from 'node:crypto';
import { addDays, formatDateOnly, todayIn } from '../../src/database/common/dates';
import type { TestApp } from './test-app';

export const TZ = 'Asia/Kolkata';
/** Calendar date `n` days from today at the test property, as YYYY-MM-DD. */
export const day = (n: number) => formatDateOnly(addDays(todayIn(TZ), n));
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export interface Session {
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
  password: string;
}

export async function registerOwner(t: TestApp, label = 'owner'): Promise<Session> {
  const email = `${label}-${randomBytes(4).toString('hex')}@example.com`;
  const password = 'Str0ng-passw0rd';
  const res = await t.http().post('/auth/register').send({ name: `Test ${label}`, email, password, organizationName: `${label} Hospitality` }).expect(201);
  return { token: res.body.data.accessToken, refreshToken: res.body.data.refreshToken, userId: res.body.data.user._id, email, password };
}

export async function login(t: TestApp, email: string, password: string): Promise<Session> {
  const res = await t.http().post('/auth/login').send({ email, password }).expect(200);
  return { token: res.body.data.accessToken, refreshToken: res.body.data.refreshToken, userId: res.body.data.user._id, email, password };
}

export interface PropertySetup {
  propertyId: string;
  slug: string;
  roomTypeId: string;
  ratePlanId: string;
  roomIds: string[];
}

/** Creates an ACTIVE property with one room type ("Deluxe AC", ₹3,500) and `rooms` physical rooms. */
export async function createPropertyWithRooms(t: TestApp, token: string, rooms = 10, opts: { basePrice?: number; publish?: boolean } = {}): Promise<PropertySetup> {
  const p = await t
    .http()
    .post('/properties')
    .set(bearer(token))
    .send({
      name: `Radha Ashram ${randomBytes(3).toString('hex')}`,
      address: 'Parikrama Marg',
      city: 'Vrindavan',
      state: 'Uttar Pradesh',
      country: 'IN',
      postalCode: '281121',
      timezone: TZ,
      currency: 'INR',
      taxPercent: 5,
      bookingHorizonDays: 60,
    })
    .expect(201);
  const propertyId = p.body.data._id;
  // Visibility is opt-in: unless a test says otherwise, publish the property's own booking page like an owner would.
  if (opts.publish !== false) await t.http().patch(`/properties/${propertyId}/visibility`).set(bearer(token)).send({ directBookingEnabled: true }).expect(200);
  const rt = await t
    .http()
    .post(`/properties/${propertyId}/room-types`)
    .set(bearer(token))
    .send({ name: 'Deluxe AC', maxOccupancy: 3, basePrice: opts.basePrice ?? 350000 })
    .expect(201);
  const roomTypeId = rt.body.data._id;
  const roomIds: string[] = [];
  for (let i = 1; i <= rooms; i++) {
    const r = await t.http().post(`/room-types/${roomTypeId}/rooms`).set(bearer(token)).send({ roomNumber: String(100 + i), floor: '1' }).expect(201);
    roomIds.push(r.body.data._id);
  }
  const plans = await t.http().get(`/properties/${propertyId}/rate-plans`).set(bearer(token)).expect(200);
  return { propertyId, slug: p.body.data.slug, roomTypeId, ratePlanId: plans.body.data[0]._id, roomIds };
}

export function reservationBody(s: PropertySetup, checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) {
  return {
    propertyId: s.propertyId,
    source: 'PHONE',
    guest: { firstName: 'Priya', lastName: 'Sharma', email: `guest-${randomBytes(3).toString('hex')}@example.com` },
    checkIn,
    checkOut,
    adults: 2,
    rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
    ...extra,
  };
}

export async function inventoryFor(t: TestApp, token: string, s: PropertySetup, from: string, to: string) {
  const res = await t.http().get(`/properties/${s.propertyId}/inventory`).query({ from, to }).set(bearer(token)).expect(200);
  return res.body.data.roomTypes.find((r: { roomTypeId: string }) => r.roomTypeId === s.roomTypeId).days as {
    date: string;
    total: number;
    sold: number;
    blocked: number;
    available: number;
    stopSell: boolean;
  }[];
}

/** A platform admin (no organization). Created straight in the database: there is deliberately no API for it. */
export async function createPlatformAdmin(t: TestApp, role: 'SUPER_ADMIN' | 'OPERATIONS_ADMIN' = 'SUPER_ADMIN', label = 'admin'): Promise<Session> {
  const { hashPassword } = await import('../../src/database/common/crypto');
  const email = `${label}-${randomBytes(4).toString('hex')}@tirvona.test`;
  const password = 'Adm1n-passw0rd!';
  await t.db.insertInto('users').values({ organizationId: null, name: `Platform ${label}`, email, passwordHash: await hashPassword(password), role, status: 'ACTIVE' }).execute();
  return login(t, email, password);
}

/** Fills in what the marketplace requires (description, photo), asks for a listing with consent, and lets `admin` approve it. */
export async function listOnMarketplace(t: TestApp, owner: Session, admin: Session, s: PropertySetup): Promise<void> {
  await t
    .http()
    .patch(`/properties/${s.propertyId}`)
    .set(bearer(owner.token))
    .send({ description: 'A quiet guest house near the temples with clean rooms, a vegetarian kitchen and friendly staff.', images: [{ url: 'https://images.example.com/a.jpg', caption: 'Front', sortOrder: 0 }] })
    .expect(200);
  await t.http().post(`/properties/${s.propertyId}/marketplace/request`).set(bearer(owner.token)).send({ consent: true }).expect(200);
  await t.http().post(`/admin/properties/${s.propertyId}/marketplace/approve`).set(bearer(admin.token)).send({}).expect(200);
}

/**
 * A member of `owner`'s organization with the given role, created straight in the database (the real invite flow is covered
 * by the auth suites). Property roles are also attached to `propertyId`.
 */
export async function createMember(t: TestApp, owner: Session, role: 'PROPERTY_MANAGER' | 'STAFF' | 'RECEPTION' | 'DEVELOPER', propertyId?: string, label = role.toLowerCase()): Promise<Session> {
  const { hashPassword } = await import('../../src/database/common/crypto');
  const org = await t.db.selectFrom('users').select('organizationId').where('id', '=', owner.userId).executeTakeFirstOrThrow();
  const email = `${label}-${randomBytes(4).toString('hex')}@example.com`;
  const password = 'Memb3r-passw0rd!';
  const user = await t.db
    .insertInto('users')
    .values({ organizationId: org.organizationId, name: `Test ${label}`, email, passwordHash: await hashPassword(password), role, status: 'ACTIVE' })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (propertyId && role !== 'DEVELOPER') await t.db.insertInto('propertyUsers').values({ propertyId, userId: user.id, role }).execute();
  return login(t, email, password);
}

/** The body of a public (guest) booking for a property from createPropertyWithRooms. */
export function publicBookingBody(s: PropertySetup, checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) {
  return {
    propertySlug: s.slug,
    checkIn,
    checkOut,
    adults: 2,
    rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
    guest: { firstName: 'Emma', lastName: 'Clarke', email: 'emma@example.com', phone: '+447700900123' },
    ...extra,
  };
}
