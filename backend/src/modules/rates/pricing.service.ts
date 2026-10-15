import { Injectable } from '@nestjs/common';
import { nightsBetween } from '../../database/common/dates';
import { percentOf } from '../../database/common/money';
import type { Promotion } from '../../database/db-types';
import { PromotionType } from '../../database/enums';
import { DomainError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';

export interface QuoteLine {
  roomTypeId: string;
  /** subtotal + tax of the line, minor units. */
  total: number;
}

/** Promotion rules for the booking engine. The discount applies to the post-tax total of eligible room types (reservation.discount semantics). */
@Injectable()
export class PricingService {
  constructor(@InjectDb() private readonly db: Db) {}

  async resolvePromotion(propertyId: string, code: string, checkIn: Date, checkOut: Date): Promise<Promotion> {
    const promo = await this.db.selectFrom('promotions').selectAll().where('propertyId', '=', propertyId).where('code', '=', code.trim().toUpperCase()).where('active', '=', true).executeTakeFirst();
    const invalid = (why: string) => new DomainError('PROMO_INVALID', `Promo code is not valid: ${why}`);
    if (!promo) throw invalid('unknown code');
    if (checkIn < promo.validFrom || checkIn >= promo.validTo) throw invalid('not valid for these dates');
    if (nightsBetween(checkIn, checkOut) < promo.minNights) throw invalid(`requires at least ${promo.minNights} nights`);
    return promo;
  }

  static discountFor(promo: Pick<Promotion, 'type' | 'value' | 'roomTypeIds'>, lines: QuoteLine[]): number {
    const eligible = lines
      .filter((l) => !promo.roomTypeIds.length || promo.roomTypeIds.includes(l.roomTypeId))
      .reduce((a, l) => a + l.total, 0);
    if (!eligible) return 0;
    return promo.type === PromotionType.PERCENTAGE ? percentOf(eligible, promo.value) : Math.min(promo.value, eligible);
  }
}
