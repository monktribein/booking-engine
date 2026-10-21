import { nightsBetween } from '../common/dates';
import { percentOf } from '../common/money';
import type { Promotion } from '../db-types';
import { PromotionType, RedemptionStatus } from '../enums';
import { DomainError } from '../errors';
import type { Db } from '../kysely';

const invalid = (why: string) => new DomainError('PROMO_INVALID', `Promo code is not valid: ${why}`);

export interface PromoLine {
  roomTypeId: string;
  /** subtotal + tax of the line, minor units. */
  total: number;
}

/**
 * Loads an active promotion by code and checks everything that does not depend on who is booking: active, dates, minimum
 * nights. With `lock`, the row is locked FOR UPDATE inside the caller's transaction, which serialises concurrent redemptions
 * of the same code so the usage limits below cannot be raced.
 */
export async function findPromotion(db: Db, propertyId: string, code: string, checkIn: Date, checkOut: Date, lock = false): Promise<Promotion> {
  let q = db.selectFrom('promotions').selectAll().where('propertyId', '=', propertyId).where('code', '=', code.trim().toUpperCase());
  if (lock) q = q.forUpdate();
  const promo = await q.executeTakeFirst();
  if (!promo || !promo.active) throw invalid(promo ? 'this code is no longer active' : 'unknown code');
  if (checkIn < promo.validFrom || checkIn >= promo.validTo) throw invalid('not valid for these dates');
  if (nightsBetween(checkIn, checkOut) < promo.minNights) throw invalid(`requires at least ${promo.minNights} nights`);
  return promo;
}

/** The discount: on the post-tax total of the eligible room types (all room types when the promotion names none). */
export function discountFor(promo: Pick<Promotion, 'type' | 'value' | 'roomTypeIds'>, lines: PromoLine[]): number {
  const eligible = eligibleTotal(promo, lines);
  if (!eligible) return 0;
  return promo.type === PromotionType.PERCENTAGE ? percentOf(eligible, promo.value) : Math.min(promo.value, eligible);
}

export function eligibleTotal(promo: Pick<Promotion, 'roomTypeIds'>, lines: PromoLine[]): number {
  return lines.filter((l) => !promo.roomTypeIds.length || promo.roomTypeIds.includes(l.roomTypeId)).reduce((a, l) => a + l.total, 0);
}

/** Minimum booking value, against the eligible post-tax total before the discount. */
export function assertMinimumValue(promo: Pick<Promotion, 'minBookingValue' | 'roomTypeIds'>, lines: PromoLine[]): void {
  const eligible = eligibleTotal(promo, lines);
  if (!eligible) throw invalid('it does not apply to the selected rooms');
  if (eligible < promo.minBookingValue) throw invalid(`the booking must be worth at least ${promo.minBookingValue / 100} before the discount`);
}

/** Usage counts of ACTIVE redemptions (cancelled and expired-hold bookings give their use back). */
export async function redemptionCounts(db: Db, promotionId: string, guestId?: string): Promise<{ total: number; guest: number }> {
  const total = await db
    .selectFrom('promotionRedemptions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('promotionId', '=', promotionId)
    .where('status', '=', RedemptionStatus.ACTIVE)
    .executeTakeFirstOrThrow();
  const guest = guestId
    ? await db
        .selectFrom('promotionRedemptions')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('promotionId', '=', promotionId)
        .where('guestId', '=', guestId)
        .where('status', '=', RedemptionStatus.ACTIVE)
        .executeTakeFirstOrThrow()
    : { n: '0' };
  return { total: Number(total.n), guest: Number(guest.n) };
}

export async function assertWithinLimits(db: Db, promo: Pick<Promotion, 'id' | 'maxRedemptions' | 'maxPerGuest'>, guestId?: string): Promise<void> {
  if (promo.maxRedemptions === null && (promo.maxPerGuest === null || !guestId)) return;
  const counts = await redemptionCounts(db, promo.id, guestId);
  if (promo.maxRedemptions !== null && counts.total >= promo.maxRedemptions) throw invalid('its usage limit has been reached');
  if (promo.maxPerGuest !== null && guestId && counts.guest >= promo.maxPerGuest) throw invalid('you have already used this code the maximum number of times');
}

/** Inside the booking transaction, after the reservation row exists. The unique key on reservation_id makes a retry harmless. */
export async function recordRedemption(tx: Db, promotionId: string, reservationId: string, guestId: string, amount: number): Promise<void> {
  await tx.insertInto('promotionRedemptions').values({ promotionId, reservationId, guestId, amount }).onConflict((oc) => oc.column('reservationId').doNothing()).execute();
}

/** Cancellation or an expired payment hold gives the use back. */
export async function releaseRedemption(tx: Db, reservationId: string, now: Date): Promise<void> {
  await tx
    .updateTable('promotionRedemptions')
    .set({ status: RedemptionStatus.RELEASED, releasedAt: now })
    .where('reservationId', '=', reservationId)
    .where('status', '=', RedemptionStatus.ACTIVE)
    .execute();
}
