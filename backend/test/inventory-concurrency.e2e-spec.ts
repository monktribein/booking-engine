import { bearer, createPropertyWithRooms, day, inventoryFor, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * THE critical guarantee: with one room left, simultaneous bookings produce
 * exactly one reservation. The others get ROOM_NOT_AVAILABLE, and inventory
 * never goes negative.
 */
describe('Double-booking prevention (inventory concurrency)', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 1); // inventory = 1
  });
  afterAll(() => t.close());

  it('inventory = 1, two simultaneous requests → A succeeds, B gets ROOM_NOT_AVAILABLE', async () => {
    const [a, b] = await Promise.all([
      t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(3), day(5))),
      t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(3), day(5))),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'ROOM_NOT_AVAILABLE', message: 'The selected room is not available.' }),
    });
    const winner = a.status === 201 ? a : b;
    expect(winner.body.success).toBe(true);
    expect(winner.body.data.reservationCode).toMatch(/^TRV-/);

    const days = await inventoryFor(t, owner.token, s, day(3), day(5));
    expect(days.map((d) => [d.available, d.sold])).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it('20 simultaneous requests for the last room on another night → exactly one booking, never negative', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(10), day(11)))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'ROOM_NOT_AVAILABLE')).toHaveLength(19);
    const [night] = await inventoryFor(t, owner.token, s, day(10), day(11));
    expect(night).toMatchObject({ total: 1, sold: 1, available: 0 });
  });

  it('multi-night stays are all-or-nothing: one sold-out night rolls back every other night', async () => {
    // Night day(21) is taken; request day(20)..day(23).
    await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(21), day(22))).expect(201);
    const res = await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(20), day(23)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROOM_NOT_AVAILABLE');
    const days = await inventoryFor(t, owner.token, s, day(20), day(23));
    expect(days.map((d) => d.available)).toEqual([1, 0, 1]); // nights 20 and 22 untouched
  });

  it('the database itself refuses available < 0 (server-side validator)', async () => {
    const coll = t.conn.db!.collection('inventory');
    const row = await coll.findOne({ available: 0 });
    await expect(coll.updateOne({ _id: row!._id }, { $inc: { available: -1, sold: 1 } })).rejects.toMatchObject({ code: 121 });
    const negatives = await coll.countDocuments({ available: { $lt: 0 } });
    expect(negatives).toBe(0);
  });
});
