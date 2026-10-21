import { OccupancyTerms, RuleLike, allocateGuests, extraGuestCharge, nightlyRate, percentChange, pickRule, priceRoomNights, rulesCollide } from './pricing';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
let seq = 0;
const rule = (o: Partial<RuleLike> & { startDate: Date; endDate: Date }): RuleLike => ({
  id: `r${++seq}`,
  ratePlanId: null,
  daysOfWeek: null,
  adjustment: 'FIXED',
  amount: 500000,
  percent: null,
  priority: 0,
  createdAt: new Date(2026, 0, 1),
  ...o,
});

describe('percentChange', () => {
  it('rounds half away from zero, symmetrically', () => {
    expect(percentChange(1005, 10)).toBe(101); // 100.5 -> 101
    expect(percentChange(1005, -10)).toBe(-101); // -100.5 -> -101, not -100
    expect(percentChange(350000, 15)).toBe(52500);
    expect(percentChange(0, 50)).toBe(0);
  });
});

describe('nightlyRate', () => {
  it('uses the base without a rule, the fixed amount for FIXED, base +/- percent for PERCENT, never below zero', () => {
    expect(nightlyRate(350000, undefined)).toBe(350000);
    expect(nightlyRate(350000, { adjustment: 'FIXED', amount: 420000, percent: null })).toBe(420000);
    expect(nightlyRate(350000, { adjustment: 'PERCENT', amount: null, percent: 20 })).toBe(420000);
    expect(nightlyRate(350000, { adjustment: 'PERCENT', amount: null, percent: -90 })).toBe(35000);
    expect(nightlyRate(100, { adjustment: 'PERCENT', amount: null, percent: -90 })).toBe(10);
  });
});

describe('pickRule precedence', () => {
  const night = d('2026-12-26'); // a Saturday
  const season = rule({ startDate: d('2026-12-20'), endDate: d('2027-01-05'), amount: 600000 });

  it('ignores rules outside the dates (end is exclusive), the weekday filter and other rate plans', () => {
    expect(pickRule([season], d('2026-12-19'), null)).toBeUndefined();
    expect(pickRule([season], d('2027-01-05'), null)).toBeUndefined();
    expect(pickRule([rule({ startDate: d('2026-12-20'), endDate: d('2027-01-05'), daysOfWeek: [1] })], night, null)).toBeUndefined();
    expect(pickRule([rule({ startDate: d('2026-12-20'), endDate: d('2027-01-05'), ratePlanId: 'other' })], night, 'mine')).toBeUndefined();
    expect(pickRule([season], night, null)).toBe(season);
  });

  it('higher priority wins over everything else', () => {
    const planSpecific = rule({ startDate: d('2026-12-20'), endDate: d('2027-01-05'), ratePlanId: 'mine', priority: 0 });
    const holiday = rule({ startDate: d('2026-12-25'), endDate: d('2026-12-27'), priority: 10 });
    expect(pickRule([planSpecific, season, holiday], night, 'mine')).toBe(holiday);
  });

  it('at equal priority: rate-plan rule, then day-of-week rule, then shorter range, then newest', () => {
    const plan = rule({ startDate: d('2026-12-01'), endDate: d('2027-02-01'), ratePlanId: 'mine' });
    expect(pickRule([season, plan], night, 'mine')).toBe(plan);

    const weekend = rule({ startDate: d('2026-12-01'), endDate: d('2027-02-01'), daysOfWeek: [0, 6] });
    expect(pickRule([season, weekend], night, null)).toBe(weekend);

    const short = rule({ startDate: d('2026-12-24'), endDate: d('2026-12-28') });
    expect(pickRule([season, short], night, null)).toBe(short);

    const older = rule({ startDate: d('2026-12-20'), endDate: d('2027-01-05'), createdAt: new Date(2026, 0, 1) });
    const newer = rule({ startDate: d('2026-12-20'), endDate: d('2027-01-05'), createdAt: new Date(2026, 5, 1) });
    expect(pickRule([older, newer], night, null)).toBe(newer);
    expect(pickRule([newer, older], night, null)).toBe(newer); // input order does not matter
  });
});

describe('rulesCollide', () => {
  const base = { ratePlanId: null, startDate: d('2026-12-01'), endDate: d('2026-12-31'), daysOfWeek: null, priority: 0 };
  it('flags a coin toss and allows deliberate layering', () => {
    const a = rule({ startDate: d('2026-12-10'), endDate: d('2027-01-10') });
    expect(rulesCollide(a, base)).toBe(true); // both every-day, overlapping, same priority
    expect(rulesCollide(a, { ...base, priority: 1 })).toBe(false);
    expect(rulesCollide(a, { ...base, ratePlanId: 'p' })).toBe(false);
    expect(rulesCollide(a, { ...base, startDate: d('2027-01-10'), endDate: d('2027-02-01') })).toBe(false); // touching, not overlapping
    expect(rulesCollide(a, { ...base, daysOfWeek: [6] })).toBe(false); // weekend price inside a season
    const w1 = rule({ startDate: d('2026-12-10'), endDate: d('2027-01-10'), daysOfWeek: [5, 6] });
    expect(rulesCollide(w1, { ...base, daysOfWeek: [6, 0] })).toBe(true);
    expect(rulesCollide(w1, { ...base, daysOfWeek: [1] })).toBe(false);
  });
});

describe('occupancy', () => {
  const terms: OccupancyTerms = { baseOccupancy: 2, maxOccupancy: 4, extraAdultCharge: 80000, extraChildCharge: 40000 };

  it('charges only guests above the base, adults counted before children', () => {
    expect(extraGuestCharge({ adults: 2, children: 0 }, terms)).toBe(0);
    expect(extraGuestCharge({ adults: 3, children: 0 }, terms)).toBe(80000);
    expect(extraGuestCharge({ adults: 2, children: 2 }, terms)).toBe(80000); // two children at 40,000
    expect(extraGuestCharge({ adults: 1, children: 2 }, terms)).toBe(40000); // one child fits in the base
    expect(extraGuestCharge({ adults: 3, children: 1 }, terms)).toBe(120000);
  });

  it('a room type without base occupancy never adds extras', () => {
    expect(extraGuestCharge({ adults: 4, children: 0 }, { ...terms, baseOccupancy: null })).toBe(0);
  });

  it('allocates the party deterministically: base first, then up to the maximum', () => {
    const rooms = [
      { baseOccupancy: 2, maxOccupancy: 3 },
      { baseOccupancy: 2, maxOccupancy: 3 },
    ];
    expect(allocateGuests(rooms, 3, 1)).toEqual([
      { adults: 2, children: 0 },
      { adults: 1, children: 1 },
    ]);
    expect(allocateGuests(rooms, 5, 0)).toEqual([
      { adults: 3, children: 0 },
      { adults: 2, children: 0 },
    ]);
    expect(allocateGuests(rooms, 1, 0)).toEqual([
      { adults: 1, children: 0 },
      { adults: 0, children: 0 },
    ]);
  });
});

describe('priceRoomNights', () => {
  it('prices each night from its own rule and adds the extra-guest charge to every night', () => {
    const nights = [d('2026-12-24'), d('2026-12-25'), d('2026-12-26')];
    const xmas = rule({ startDate: d('2026-12-25'), endDate: d('2026-12-27'), adjustment: 'PERCENT', amount: null, percent: 50 });
    const out = priceRoomNights({
      nights,
      basePrice: 300000,
      ratePlanId: null,
      rules: [xmas],
      guests: { adults: 3, children: 0 },
      terms: { baseOccupancy: 2, maxOccupancy: 3, extraAdultCharge: 50000, extraChildCharge: 0 },
    });
    expect(out.map((n) => [n.date, n.rate, n.extra, n.amount])).toEqual([
      ['2026-12-24', 300000, 50000, 350000],
      ['2026-12-25', 450000, 50000, 500000],
      ['2026-12-26', 450000, 50000, 500000],
    ]);
    expect(out[0].ruleId).toBeUndefined();
    expect(out[1].ruleId).toBe(xmas.id);
  });
});
