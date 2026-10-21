import { bearer, createMember, createPropertyWithRooms, day, inventoryFor, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

describe('Physical room retirement', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;

  const http = () => t.http();
  const retire = (roomId: string, token = owner.token, reason = 'Merged into another room') => http().post(`/rooms/${roomId}/retire`).set(bearer(token)).send({ reason });
  const create = (checkIn: string, checkOut: string) => http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, checkIn, checkOut));
  const lineOf = (r: { reservationRooms: { _id: string }[] }) => r.reservationRooms[0]._id;
  const assign = (reservationId: string, lineId: string, roomId: string) => http().post(`/reservations/${reservationId}/assign-room`).set(bearer(owner.token)).send({ reservationRoomId: lineId, roomId });
  const rooms = async (includeRetired = false) =>
    (await http().get(`/room-types/${s.roomTypeId}/rooms`).query(includeRetired ? { includeRetired: 'true' } : {}).set(bearer(owner.token)).expect(200)).body.data as { _id: string; roomNumber: string; status: string; retiredAt?: string }[];

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 6);
  });
  afterAll(() => t.close());

  it('refuses while an upcoming reservation is assigned, names it, and allows it after reassignment', async () => {
    const r = (await create(day(5), day(7)).expect(201)).body.data;
    await assign(r._id, lineOf(r), s.roomIds[0]).expect(200);

    const check = (await http().get(`/rooms/${s.roomIds[0]}/retirement-check`).set(bearer(owner.token)).expect(200)).body.data;
    expect(check.canRetire).toBe(false);
    expect(check.upcomingReservations.map((x: { reservationCode: string }) => x.reservationCode)).toEqual([r.reservationCode]);

    const blocked = await retire(s.roomIds[0]);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ROOM_HAS_FUTURE_BOOKINGS');
    expect(blocked.body.error.details.reservations[0]).toMatchObject({ reservationCode: r.reservationCode, checkIn: day(5), checkOut: day(7) });
    expect((await inventoryFor(t, owner.token, s, day(5), day(6)))[0].total).toBe(6); // nothing changed

    await assign(r._id, lineOf(r), s.roomIds[1]).expect(200);
    const ok = await retire(s.roomIds[0]).expect(200);
    expect(ok.body.data).toMatchObject({ status: 'RETIRED', roomNumber: '101' });
    expect(ok.body.data.retiredAt).toBeTruthy();
    // The reservation keeps pointing at the room it was moved to.
    const after = (await http().get(`/reservations/${r._id}`).set(bearer(owner.token)).expect(200)).body.data;
    expect(after.reservationRooms[0].roomNumber).toBe('102');
  });

  it('takes the capacity out of the inventory, hides the room from pickers, and is idempotent', async () => {
    expect((await inventoryFor(t, owner.token, s, day(5), day(6)))[0]).toMatchObject({ total: 5, available: 4, sold: 1 });
    expect((await rooms()).map((x) => x.roomNumber)).not.toContain('101');
    const all = await rooms(true);
    expect(all.find((x) => x.roomNumber === '101')).toMatchObject({ status: 'RETIRED' });

    const again = await retire(s.roomIds[0]).expect(200);
    expect(again.body.data.status).toBe('RETIRED');
    expect((await inventoryFor(t, owner.token, s, day(5), day(6)))[0].total).toBe(5); // not removed twice

    // A retired room can neither be assigned, edited nor given a housekeeping status.
    const r2 = (await create(day(8), day(9)).expect(201)).body.data;
    expect((await assign(r2._id, lineOf(r2), s.roomIds[0])).status).toBe(400);
    expect((await http().patch(`/rooms/${s.roomIds[0]}`).set(bearer(owner.token)).send({ floor: '9' })).status).toBe(409);
    expect((await http().post(`/rooms/${s.roomIds[0]}/status`).set(bearer(owner.token)).send({ status: 'AVAILABLE' })).status).toBe(409);
    // Availability never offers it: five rooms are left to sell.
    const avail = await http().get(`/public/properties/${s.slug}/availability`).query({ checkIn: day(20), checkOut: day(21), adults: 2, rooms: 6 }).expect(200);
    expect(avail.body.data[0].bookable).toBe(false);
    expect(avail.body.data[0].reasons.join(' ')).toMatch(/only 5 room/);
  });

  it('keeps history: a completed stay still shows its room, and the number can be reused', async () => {
    const stay = (await create(day(0), day(1)).expect(201)).body.data;
    await assign(stay._id, lineOf(stay), s.roomIds[2]).expect(200);
    await http().post(`/reservations/${stay._id}/check-in`).set(bearer(owner.token)).send({}).expect(200);
    // occupied: refused
    const occupied = await retire(s.roomIds[2]);
    expect(occupied.status).toBe(409);
    expect(occupied.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await http().post(`/reservations/${stay._id}/check-out`).set(bearer(owner.token)).send({}).expect(200);
    await retire(s.roomIds[2]).expect(200);
    const done = (await http().get(`/reservations/${stay._id}`).set(bearer(owner.token)).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'CHECKED_OUT' });
    expect(done.reservationRooms[0].roomNumber).toBe('103');
    // The retired number is free again for a new physical room...
    const reuse = await http().post(`/room-types/${s.roomTypeId}/rooms`).set(bearer(owner.token)).send({ roomNumber: '103' }).expect(201);
    // ...and then the old room cannot come back under the same number.
    const clash = await http().post(`/rooms/${s.roomIds[2]}/reinstate`).set(bearer(owner.token)).send({});
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('DUPLICATE');
    await http().patch(`/rooms/${reuse.body.data._id}`).set(bearer(owner.token)).send({ roomNumber: '103A' }).expect(200);
    const back = await http().post(`/rooms/${s.roomIds[2]}/reinstate`).set(bearer(owner.token)).send({}).expect(200);
    expect(back.body.data).toMatchObject({ status: 'AVAILABLE', retiredAt: null });
  });

  it('releases its own maintenance block when retiring', async () => {
    const room = s.roomIds[3];
    await http().post(`/rooms/${room}/status`).set(bearer(owner.token)).send({ status: 'MAINTENANCE', blockUntil: day(12) }).expect(200);
    const before = (await inventoryFor(t, owner.token, s, day(3), day(4)))[0];
    expect(before.blocked).toBe(1);
    await retire(room).expect(200);
    const after = (await inventoryFor(t, owner.token, s, day(3), day(4)))[0];
    expect(after.blocked).toBe(0);
    expect(after.total).toBe(before.total - 1);
    expect(after.available + after.sold + after.blocked).toBe(after.total);
  });

  it('retiring and assigning the same room race safely: exactly one wins', async () => {
    for (let i = 0; i < 4; i++) {
      const room = (await http().post(`/room-types/${s.roomTypeId}/rooms`).set(bearer(owner.token)).send({ roomNumber: `RACE${i}` }).expect(201)).body.data._id;
      const r = (await create(day(30 + i * 2), day(31 + i * 2)).expect(201)).body.data;
      const [a, b] = await Promise.all([assign(r._id, lineOf(r), room), retire(room)]);
      expect({ assigned: a.status === 200, retired: b.status === 200 }).not.toEqual({ assigned: true, retired: true });
      // Whatever happened, the books balance and the assignment never points at a retired room.
      const row = await t.db.selectFrom('rooms').select('status').where('id', '=', room).executeTakeFirstOrThrow();
      const line = await t.db.selectFrom('reservationRooms').select('roomId').where('reservationId', '=', r._id).executeTakeFirstOrThrow();
      if (row.status === 'RETIRED') expect(line.roomId).toBeNull();
      const night = (await inventoryFor(t, owner.token, s, day(30 + i * 2), day(31 + i * 2)))[0];
      expect(night.available + night.sold + night.blocked).toBe(night.total);
    }
  });

  it('is limited to people who manage rooms, and to the owning organization', async () => {
    const reception = await createMember(t, owner, 'RECEPTION', s.propertyId);
    expect((await retire(s.roomIds[4], reception.token)).status).toBe(403);
    const other = await registerOwner(t, 'other');
    expect([403, 404]).toContain((await retire(s.roomIds[4], other.token)).status);
    expect([403, 404]).toContain((await http().get(`/rooms/${s.roomIds[4]}/retirement-check`).set(bearer(other.token))).status);
    expect((await retire(s.roomIds[4], owner.token, 'x')).status).toBe(400); // a reason is required (3+ characters)
  });
});
