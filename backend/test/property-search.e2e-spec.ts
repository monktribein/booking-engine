import { bearer, createPropertyWithRooms, day, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

/** Public cross-property search for the guest-facing site: GET /public/properties. */
describe('Public property search', () => {
  let t: TestApp;
  let ownerA: Session;
  let ownerB: Session;
  let cheap: PropertySetup; // Goa, WiFi + Pool, ₹2,000, 2 rooms
  let mid: PropertySetup; // Goa, WiFi, ₹3,500, 3 rooms
  let pricey: PropertySetup; // Jaipur, WiFi + Pool + Spa, ₹9,000, 3 rooms
  let hidden: PropertySetup; // Goa but INACTIVE
  let n = 0;

  const search = (query: Record<string, unknown> = {}) => t.http().get('/public/properties').set('X-Forwarded-For', `10.7.${Math.floor(++n / 250)}.${n % 250}`).query(query);
  const slugs = async (query: Record<string, unknown> = {}) => ((await search(query).expect(200)).body.data.items as { slug: string }[]).map((i) => i.slug);
  const patch = (s: PropertySetup, token: string, body: Record<string, unknown>) => t.http().patch(`/properties/${s.propertyId}`).set(bearer(token)).send(body).expect(200);

  beforeAll(async () => {
    t = await createTestApp({ BOOKING_ENGINE_REQUIRE_PAYMENT: 'false' }); // bookings confirm at once: no payment gateway needed here
    ownerA = await registerOwner(t, 'searcha');
    ownerB = await registerOwner(t, 'searchb');
    cheap = await createPropertyWithRooms(t, ownerA.token, 2, { basePrice: 200000 });
    mid = await createPropertyWithRooms(t, ownerA.token, 3, { basePrice: 350000 });
    pricey = await createPropertyWithRooms(t, ownerB.token, 3, { basePrice: 900000 });
    hidden = await createPropertyWithRooms(t, ownerB.token, 3, { basePrice: 100000 });
    await patch(cheap, ownerA.token, { city: 'Goa', state: 'Goa', amenities: ['WiFi', 'Pool'], description: 'Beach hut near the shore' });
    await patch(mid, ownerA.token, { city: 'Goa', state: 'Goa', amenities: ['WiFi'] });
    await patch(pricey, ownerB.token, { city: 'Jaipur', state: 'Rajasthan', amenities: ['WiFi', 'Pool', 'Spa'] });
    await patch(hidden, ownerB.token, { city: 'Goa', state: 'Goa', status: 'INACTIVE' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('lists active properties of every organization with the public fields only', async () => {
    const res = (await search().expect(200)).body.data;
    expect(res.total).toBe(3);
    const item = res.items.find((i: { slug: string }) => i.slug === cheap.slug);
    expect(item).toMatchObject({ name: expect.any(String), city: 'Goa', state: 'Goa', country: 'IN', currency: 'INR', startingFromPrice: 200000, amenities: ['WiFi', 'Pool'], description: 'Beach hut near the shore' });
    expect(Object.keys(item).sort()).toEqual(['amenities', 'city', 'country', 'currency', 'description', 'image', 'maxOccupancy', 'name', 'slug', 'startingFromPrice', 'state']);
    expect(JSON.stringify(res)).not.toMatch(/organizationId|ownerId|postalCode|taxPercent|_id/);
    expect(await slugs()).not.toContain(hidden.slug); // INACTIVE never appears
  });

  it('filters by destination text, exact city and country', async () => {
    expect((await slugs({ city: 'goa' })).sort()).toEqual([cheap.slug, mid.slug].sort()); // case-insensitive
    expect(await slugs({ city: 'Jaipur' })).toEqual([pricey.slug]);
    expect(await slugs({ q: 'rajasthan' })).toEqual([pricey.slug]); // matches the state
    expect(await slugs({ q: 'zzz-nothing' })).toEqual([]);
    expect(await slugs({ country: 'IN', city: 'Goa' })).toHaveLength(2);
    expect(await slugs({ country: 'FR' })).toEqual([]);
  });

  it('treats the text as literal characters, never as a regular expression', async () => {
    expect(await slugs({ q: '.*' })).toEqual([]);
    expect(await slugs({ city: '.*' })).toEqual([]);
    expect(await slugs({ q: '(' })).toEqual([]);
  });

  it('requires every requested amenity, ignoring case', async () => {
    expect((await slugs({ amenities: 'wifi' })).sort()).toEqual([cheap.slug, mid.slug, pricey.slug].sort());
    expect((await slugs({ amenities: 'WIFI, pool' })).sort()).toEqual([cheap.slug, pricey.slug].sort());
    expect(await slugs({ amenities: 'wifi,pool,spa' })).toEqual([pricey.slug]);
    expect(await slugs({ amenities: 'helipad' })).toEqual([]);
  });

  it('filters by nightly price and sorts', async () => {
    expect(await slugs({ minPrice: 300000, maxPrice: 400000 })).toEqual([mid.slug]);
    expect(await slugs({ maxPrice: 199999 })).toEqual([]);
    expect(await slugs({ sort: 'price_asc' })).toEqual([cheap.slug, mid.slug, pricey.slug]);
    expect(await slugs({ sort: 'price_desc' })).toEqual([pricey.slug, mid.slug, cheap.slug]);
  });

  it('with dates: only properties that can host the stay, priced for it (tax included)', async () => {
    const res = (await search({ checkIn: day(5), checkOut: day(7), adults: 2 }).expect(200)).body.data;
    expect(res.total).toBe(3);
    const c = res.items.find((i: { slug: string }) => i.slug === cheap.slug);
    expect(c).toMatchObject({ nights: 2, availableFromNightly: 200000, availableFromTotal: 2 * 200000 * 1.05, availableRoomTypes: 1 });
    // price filter applies to the nightly price of the stay
    expect(await slugs({ checkIn: day(5), checkOut: day(7), adults: 2, maxPrice: 250000 })).toEqual([cheap.slug]);
  });

  it('a sold-out property disappears for those dates only', async () => {
    const book = (s: PropertySetup, from: number, to: number, i: number) =>
      t.http().post('/public/reservations').set('Idempotency-Key', `search-soldout-${s.slug}-${i}-abcd`).set('X-Forwarded-For', `10.8.0.${++n % 250}`).send({
        propertySlug: s.slug,
        checkIn: day(from),
        checkOut: day(to),
        adults: 2,
        rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
        guest: { firstName: 'A', lastName: 'B', email: `s${i}@example.com`, phone: '+919811111111' },
      });
    await book(cheap, 20, 22, 1).expect(201);
    await book(cheap, 20, 22, 2).expect(201); // both rooms held
    expect(await slugs({ checkIn: day(20), checkOut: day(22), adults: 2 })).not.toContain(cheap.slug);
    expect(await slugs({ checkIn: day(20), checkOut: day(22), adults: 2 })).toContain(mid.slug);
    expect(await slugs({ checkIn: day(30), checkOut: day(32), adults: 2 })).toContain(cheap.slug); // other dates unaffected
    // two rooms wanted but only 2... a third room type of demand: asking for 3 rooms excludes the 2-room property
    expect(await slugs({ checkIn: day(40), checkOut: day(41), adults: 2, rooms: 3 })).not.toContain(cheap.slug);
  });

  it('respects guest count: nothing is offered when no room fits the party', async () => {
    expect(await slugs({ checkIn: day(5), checkOut: day(6), adults: 10 })).toEqual([]); // max occupancy is 3 per room
  });

  it('dates beyond the bookable horizon return nothing instead of an error', async () => {
    expect(await slugs({ checkIn: day(200), checkOut: day(202), adults: 2 })).toEqual([]);
  });

  it('paginates and caps the page size', async () => {
    const p1 = (await search({ limit: 2, page: 1, sort: 'price_asc' }).expect(200)).body.data;
    const p2 = (await search({ limit: 2, page: 2, sort: 'price_asc' }).expect(200)).body.data;
    expect(p1).toMatchObject({ page: 1, limit: 2, total: 3 });
    expect(p1.items.map((i: { slug: string }) => i.slug)).toEqual([cheap.slug, mid.slug]);
    expect(p2.items.map((i: { slug: string }) => i.slug)).toEqual([pricey.slug]);
    expect((await search({ limit: 25 })).status).toBe(400);
  });

  it('validates the input', async () => {
    for (const bad of [{ checkIn: day(5) }, { checkOut: day(7) }, { checkIn: day(7), checkOut: day(5), adults: 2 }, { minPrice: 5, maxPrice: 1 }, { minPrice: -1 }, { adults: 0 }, { country: 'india' }, { sort: 'random' }, { checkIn: 'tomorrow', checkOut: 'later' }]) {
      const res = await search(bad);
      expect([bad, res.status]).toEqual([bad, 400]);
    }
  });

  it('needs no authentication and is rate limited per client (30 searches a minute)', async () => {
    const hit = () => t.http().get('/public/properties').set('X-Forwarded-For', '10.9.9.9');
    for (let i = 0; i < 30; i++) expect((await hit()).status).toBe(200);
    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await search()).status).toBe(200); // another client is unaffected
  });
});
