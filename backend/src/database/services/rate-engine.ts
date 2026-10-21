import { RateRuleStatus } from '../enums';
import type { Db } from '../kysely';
import { RuleLike } from '../common/pricing';
import { d } from '../sql';
import { formatDateOnly } from '../common/dates';

export type LoadedRule = RuleLike & { roomTypeId: string };

/**
 * The active rate rules that can touch any night of [from, to) for the given room types of one property.
 * Pass a transaction as `db` to price inside the booking transaction.
 */
export async function loadRateRules(db: Db, propertyId: string, roomTypeIds: readonly string[], from: Date, to: Date): Promise<LoadedRule[]> {
  if (!roomTypeIds.length) return [];
  const rows = await db
    .selectFrom('rateRules')
    .select(['id', 'roomTypeId', 'ratePlanId', 'startDate', 'endDate', 'daysOfWeek', 'adjustment', 'amount', 'percent', 'priority', 'createdAt'])
    .where('propertyId', '=', propertyId)
    .where('roomTypeId', 'in', [...roomTypeIds])
    .where('status', '=', RateRuleStatus.ACTIVE)
    .where('startDate', '<', d(formatDateOnly(to)))
    .where('endDate', '>', d(formatDateOnly(from)))
    .execute();
  return rows.map((r) => ({ ...r, daysOfWeek: r.daysOfWeek && r.daysOfWeek.length ? r.daysOfWeek.map(Number) : null, amount: r.amount === null ? null : Number(r.amount), percent: r.percent === null ? null : Number(r.percent) }));
}
