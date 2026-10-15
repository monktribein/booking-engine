import { formatDateOnly, nightsBetween } from './dates';

export interface RestrictionRow {
  date: Date;
  minimumStay?: number | null;
  maximumStay?: number | null;
  closed?: boolean;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
}

/**
 * Applies the channel-manager conventions to one room type's restriction rows
 * for a stay [checkIn, checkOut):
 *  - closed / stopSell apply to every night of the stay;
 *  - closedToArrival and min/max stay are read from the arrival date;
 *  - closedToDeparture is read from the departure date.
 * Pass rows for dates checkIn..checkOut inclusive. Returns human-readable violations.
 */
export function evaluateRestrictions(rows: readonly RestrictionRow[], checkIn: Date, checkOut: Date): string[] {
  const nights = nightsBetween(checkIn, checkOut);
  const inT = checkIn.getTime();
  const outT = checkOut.getTime();
  const violations: string[] = [];

  for (const r of rows) {
    const t = r.date.getTime();
    const day = formatDateOnly(r.date);
    if (t >= inT && t < outT && (r.closed || r.stopSell)) violations.push(`closed for sale on ${day}`);
    if (t === inT) {
      if (r.closedToArrival) violations.push(`closed to arrival on ${day}`);
      if (r.minimumStay && nights < r.minimumStay) violations.push(`minimum stay is ${r.minimumStay} nights from ${day}`);
      if (r.maximumStay && nights > r.maximumStay) violations.push(`maximum stay is ${r.maximumStay} nights from ${day}`);
    }
    if (t === outT && r.closedToDeparture) violations.push(`closed to departure on ${day}`);
  }
  return violations;
}
