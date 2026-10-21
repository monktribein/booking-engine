import { Injectable } from '@nestjs/common';
import type { Promotion } from '../../database/db-types';
import { Db, InjectDb } from '../../database/kysely';
import { PromoLine, assertMinimumValue, assertWithinLimits, discountFor, findPromotion } from '../../database/services/promotion';

export type QuoteLine = PromoLine;

/**
 * Promotion rules for the booking engine's price previews. The binding checks (usage limits under a row lock, per-guest limits,
 * the redemption record) run inside the booking transaction in ReservationService; this service only answers "would this code
 * apply?" for a quote. The discount applies to the post-tax total of eligible room types (reservation.discount semantics).
 */
@Injectable()
export class PricingService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Throws PROMO_INVALID with the reason: unknown, inactive, wrong dates, too few nights, or its usage limit is used up. */
  async resolvePromotion(propertyId: string, code: string, checkIn: Date, checkOut: Date): Promise<Promotion> {
    const promo = await findPromotion(this.db, propertyId, code, checkIn, checkOut);
    await assertWithinLimits(this.db, promo);
    return promo;
  }

  static discountFor(promo: Pick<Promotion, 'type' | 'value' | 'roomTypeIds'>, lines: QuoteLine[]): number {
    return discountFor(promo, lines);
  }

  /** The reason a quoted line does not meet the code's minimum booking value, or undefined if it does. */
  static minimumValueProblem(promo: Pick<Promotion, 'minBookingValue' | 'roomTypeIds'>, lines: QuoteLine[]): string | undefined {
    try {
      assertMinimumValue(promo, lines);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }
}
