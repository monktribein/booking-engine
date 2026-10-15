import { bearer, PropertySetup } from './fixtures';
import type { TestApp } from './test-app';

/** Runs the real connect flow against the mock OTA: connect → consent redirect → callback → CONNECTED. */
export async function connectMock(t: TestApp, token: string, s: PropertySetup) {
  const start = await t.http().post(`/properties/${s.propertyId}/channels/MOCK/connect`).set(bearer(token)).expect(200);
  const consent = new URL(start.body.data.authorizationUrl);
  const toCallback = await t.http().get(consent.pathname + consent.search).expect(302);
  const callback = new URL(toCallback.headers.location);
  const back = await t.http().get(callback.pathname + callback.search).expect(302);
  return { start: start.body.data, finalRedirect: back.headers.location as string };
}

/** Maps the mock hotel's Deluxe room and the single-unit listing to the property's room type. */
export function mapMock(t: TestApp, token: string, s: PropertySetup) {
  return t
    .http()
    .post(`/properties/${s.propertyId}/channels/MOCK/mappings`)
    .set(bearer(token))
    .send({
      mappings: [
        {
          externalListingId: 'MOCK-HOTEL-1',
          externalRoomId: 'MOCK-ROOM-DLX',
          roomTypeId: s.roomTypeId,
          ratePlans: [{ externalRatePlanId: 'MOCK-ROOM-DLX-FLEX', ratePlanId: s.ratePlanId, markupType: 'PERCENTAGE', markupValue: 10 }],
        },
        { externalListingId: 'MOCK-LISTING-1', externalRoomId: null, roomTypeId: s.roomTypeId },
      ],
    });
}
