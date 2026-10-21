/**
 * Pure pricing rules. No database, no clock: everything a quote, a booking and a re-price need so they cannot disagree.
 *
 * Order of calculation for one room and one night (all amounts are integers in minor units):
 *
 *   1. base       the rate plan's base price
 *   2. rule       the winning rate rule for that night (if any) replaces the base (FIXED) or adjusts it (PERCENT)
 *   3. extra      extra-guest charge for guests above the room type's base occupancy
 *   night amount = rule price + extra
 *   room subtotal = sum of night amounts
 *   tax           = property tax percent of the room subtotal, rounded half away from zero, per room
 *   total         = subtotal + tax
 *   discount      (promotion) is taken off the post-tax total of the eligible rooms, so it never changes the tax base
 *
 * Which rule wins when several match a night: highest priority; then a rule for this rate plan over one for the whole room
 * type; then a day-of-week rule over an every-day rule; then the shorter date range; then the newest; then the id. The result
 * is deterministic, and rules that would tie on priority within the same scope are refused when they are created.
 */

export interface RuleLike {
  id: string;
  ratePlanId: string | null;
  startDate: Date;
  endDate: Date;
  daysOfWeek: number[] | null;
  adjustment: string;
  amount: number | null;
  percent: number | null;
  priority: number;
  createdAt: Date;
}

export interface OccupancyTerms {
  baseOccupancy: number | null;
  maxOccupancy: number;
  extraAdultCharge: number;
  extraChildCharge: number;
}

export interface NightPrice {
  date: string;
  amount: number;
  rate: number;
  extra: number;
  ruleId?: string;
}

const DAY_MS = 86_400_000;

/** Percent of an amount, rounded half away from zero (so +x% and -x% are symmetric). */
export function percentChange(amount: number, percent: number): number {
  const raw = (amount * percent) / 100;
  return raw < 0 ? -Math.round(-raw) : Math.round(raw);
}

/** Does the rule apply to this night (a UTC-midnight calendar date) for this rate plan? */
export function ruleApplies(rule: RuleLike, night: Date, ratePlanId: string | null): boolean {
  if (night < rule.startDate || night >= rule.endDate) return false;
  if (rule.ratePlanId !== null && rule.ratePlanId !== ratePlanId) return false;
  if (rule.daysOfWeek && !rule.daysOfWeek.includes(night.getUTCDay())) return false;
  return true;
}

const span = (r: RuleLike) => r.endDate.getTime() - r.startDate.getTime();

/** The single rule that sets the price of this night, or undefined. */
export function pickRule<R extends RuleLike>(rules: readonly R[], night: Date, ratePlanId: string | null): R | undefined {
  return rules
    .filter((r) => ruleApplies(r, night, ratePlanId))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        Number(b.ratePlanId !== null) - Number(a.ratePlanId !== null) ||
        Number(b.daysOfWeek !== null) - Number(a.daysOfWeek !== null) ||
        span(a) - span(b) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )[0];
}

/** The nightly room price before extra-guest charges. */
export function nightlyRate(base: number, rule: Pick<RuleLike, 'adjustment' | 'amount' | 'percent'> | undefined): number {
  if (!rule) return base;
  if (rule.adjustment === 'FIXED') return Math.max(0, rule.amount ?? base);
  return Math.max(0, base + percentChange(base, rule.percent ?? 0));
}

export interface LineGuests {
  adults: number;
  children: number;
}

/**
 * Splits the party over the rooms of a booking, in order. Every room first receives guests up to its base occupancy
 * (adults before children), then the remainder fills rooms up to their maximum. Deterministic, so a quote and the booking
 * that follows charge the same extras. The caller has already checked that the party fits the combined maximum.
 */
export function allocateGuests(rooms: readonly { baseOccupancy: number; maxOccupancy: number }[], adults: number, children: number): LineGuests[] {
  const out: LineGuests[] = rooms.map(() => ({ adults: 0, children: 0 }));
  let a = adults;
  let c = children;
  const room = (i: number) => out[i].adults + out[i].children;
  for (const limit of ['baseOccupancy', 'maxOccupancy'] as const) {
    for (let i = 0; i < rooms.length; i++) {
      while (room(i) < rooms[i][limit] && a > 0) {
        out[i].adults++;
        a--;
      }
      while (room(i) < rooms[i][limit] && c > 0) {
        out[i].children++;
        c--;
      }
    }
  }
  // Anything left cannot be seated; put it on the last room so it is still charged (callers reject it earlier).
  if (out.length) {
    out[out.length - 1].adults += a;
    out[out.length - 1].children += c;
  }
  return out;
}

/** Per-night extra-guest charge of one room: guests above the base occupancy, adults counted before children. */
export function extraGuestCharge(guests: LineGuests, terms: OccupancyTerms): number {
  const base = terms.baseOccupancy ?? terms.maxOccupancy;
  const includedAdults = Math.min(guests.adults, base);
  const includedChildren = Math.min(guests.children, Math.max(0, base - includedAdults));
  const extraAdults = guests.adults - includedAdults;
  const extraChildren = guests.children - includedChildren;
  return extraAdults * terms.extraAdultCharge + extraChildren * terms.extraChildCharge;
}

export function baseOccupancyOf(terms: Pick<OccupancyTerms, 'baseOccupancy' | 'maxOccupancy'>): number {
  return terms.baseOccupancy ?? terms.maxOccupancy;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Prices every night of one room. */
export function priceRoomNights(input: {
  nights: readonly Date[];
  basePrice: number;
  ratePlanId: string | null;
  rules: readonly RuleLike[];
  guests: LineGuests;
  terms: OccupancyTerms;
}): NightPrice[] {
  const extra = extraGuestCharge(input.guests, input.terms);
  return input.nights.map((night) => {
    const rule = pickRule(input.rules, night, input.ratePlanId);
    const rate = nightlyRate(input.basePrice, rule);
    return { date: isoDate(night), amount: rate + extra, rate, extra, ...(rule ? { ruleId: rule.id } : {}) };
  });
}

/**
 * Two rules whose winner would be a coin toss: same priority, same rate-plan scope, overlapping dates, and the same kind of day
 * filter (both every-day, or both day-of-week with a shared day). A day-of-week rule laid over an every-day rule (a weekend
 * price inside a season) is a deliberate layer, not a collision: the day-specific rule wins.
 */
export function rulesCollide(a: RuleLike, b: Pick<RuleLike, 'ratePlanId' | 'startDate' | 'endDate' | 'daysOfWeek' | 'priority'>): boolean {
  if (a.priority !== b.priority) return false;
  if (a.ratePlanId !== b.ratePlanId) return false;
  if (!(a.startDate < b.endDate && b.startDate < a.endDate)) return false;
  if (!a.daysOfWeek && !b.daysOfWeek) return true;
  if (!a.daysOfWeek || !b.daysOfWeek) return false;
  return a.daysOfWeek.some((x) => b.daysOfWeek!.includes(x));
}

export { DAY_MS };
