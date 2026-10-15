import { Types } from 'mongoose';
import { PricingService } from '../../modules/rates/pricing.service';
import { PromotionType } from '../schemas/promotion.schema';
import { eachNight, localDateTimeToInstant, toDateOnly } from './dates';
import { percentOf } from './money';
import { REDACTED, redactSecrets } from './redact';
import { evaluateRestrictions } from './restrictions';

const D = toDateOnly;

describe('calendar dates', () => {
  it('parses strict YYYY-MM-DD and rejects impossible dates', () => {
    expect(D('2026-10-05').toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(() => D('2026-02-30')).toThrow(/Invalid calendar date/);
    expect(() => D('05/10/2026')).toThrow(/YYYY-MM-DD/);
  });

  it('stays are half-open [checkIn, checkOut)', () => {
    expect(eachNight(D('2026-10-05'), D('2026-10-08')).map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('converts local check-in time to an instant in the property zone', () => {
    expect(localDateTimeToInstant(D('2026-10-05'), '14:00', 'Asia/Kolkata').toISOString()).toBe('2026-10-05T08:30:00.000Z');
  });
});

describe('restriction evaluation', () => {
  const inD = D('2026-10-05');
  const outD = D('2026-10-07');
  it('min stay and CTA read on arrival, CTD on departure, closed on any night', () => {
    expect(evaluateRestrictions([{ date: inD, minimumStay: 3 }], inD, outD)).toEqual(['minimum stay is 3 nights from 2026-10-05']);
    expect(evaluateRestrictions([{ date: D('2026-10-06'), minimumStay: 3 }], inD, outD)).toEqual([]);
    expect(evaluateRestrictions([{ date: inD, closedToArrival: true }], inD, outD)).toHaveLength(1);
    expect(evaluateRestrictions([{ date: outD, closedToDeparture: true }], inD, outD)).toHaveLength(1);
    expect(evaluateRestrictions([{ date: outD, stopSell: true }], inD, outD)).toEqual([]); // departure night is not stayed
    expect(evaluateRestrictions([{ date: D('2026-10-06'), stopSell: true }], inD, outD)).toEqual(['closed for sale on 2026-10-06']);
    expect(evaluateRestrictions([{ date: inD, maximumStay: 1 }], inD, outD)).toHaveLength(1);
  });
});

describe('secret redaction', () => {
  it('masks credential-like keys and card numbers, keeps the rest', () => {
    const out = redactSecrets({
      headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k' },
      accessToken: 't',
      refresh_token: 'r',
      passwordHash: 'h',
      note: 'card 4111 1111 1111 1111 used',
      company: 'Acme',
      amount: 1200,
    });
    expect(out).toEqual({
      headers: { Authorization: REDACTED, 'X-Api-Key': REDACTED },
      accessToken: REDACTED,
      refresh_token: REDACTED,
      passwordHash: REDACTED,
      note: `card ${REDACTED} used`,
      company: 'Acme',
      amount: 1200,
    });
  });
});

describe('pricing', () => {
  const rt = new Types.ObjectId();
  it('percent discount on eligible lines; fixed discount capped at the total', () => {
    expect(PricingService.discountFor({ type: PromotionType.PERCENTAGE, value: 10, roomTypeIds: [] }, [{ roomTypeId: rt, total: 735000 }])).toBe(73500);
    expect(PricingService.discountFor({ type: PromotionType.FIXED, value: 900000, roomTypeIds: [] }, [{ roomTypeId: rt, total: 735000 }])).toBe(735000);
    expect(PricingService.discountFor({ type: PromotionType.PERCENTAGE, value: 10, roomTypeIds: [new Types.ObjectId()] }, [{ roomTypeId: rt, total: 735000 }])).toBe(0);
  });
  it('rounds money half-up in minor units', () => {
    expect(percentOf(333, 5)).toBe(17);
  });
});
