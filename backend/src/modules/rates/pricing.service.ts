import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { nightsBetween } from '../../database/common/dates';
import { percentOf } from '../../database/common/money';
import { DomainError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import { Promotion, PromotionType } from '../../database/schemas/promotion.schema';

export interface QuoteLine {
  roomTypeId: Types.ObjectId;
  /** subtotal + tax of the line, minor units. */
  total: number;
}

/**
 * Promotion rules for the booking engine. The discount applies to the
 * post-tax total of eligible room types (reservation.discount semantics).
 */
@Injectable()
export class PricingService {
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

  async resolvePromotion(propertyId: Types.ObjectId, code: string, checkIn: Date, checkOut: Date): Promise<Promotion> {
    const promo = await this.m.Promotion.findOne({ propertyId, code: code.trim().toUpperCase(), active: true }).lean();
    const invalid = (why: string) => new DomainError('PROMO_INVALID', `Promo code is not valid: ${why}`);
    if (!promo) throw invalid('unknown code');
    if (checkIn < promo.validFrom || checkIn >= promo.validTo) throw invalid('not valid for these dates');
    if (nightsBetween(checkIn, checkOut) < promo.minNights) throw invalid(`requires at least ${promo.minNights} nights`);
    return promo;
  }

  static discountFor(promo: Pick<Promotion, 'type' | 'value' | 'roomTypeIds'>, lines: QuoteLine[]): number {
    const eligible = lines
      .filter((l) => !promo.roomTypeIds.length || promo.roomTypeIds.some((id) => id.equals(l.roomTypeId)))
      .reduce((a, l) => a + l.total, 0);
    if (!eligible) return 0;
    return promo.type === PromotionType.PERCENTAGE ? percentOf(eligible, promo.value) : Math.min(promo.value, eligible);
  }
}
