import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL } from '../constants';
import { baseSchemaOptions, count, dateOnly, enumOf, objectId } from '../common/schema-helpers';

export enum PromotionType {
  PERCENTAGE = 'PERCENTAGE',
  /** Minor units off the whole stay. */
  FIXED = 'FIXED',
}

/**
 * Promo codes for the direct booking engine. The discount is applied at the
 * reservation level (reservation.discount, post-tax), and the code used is
 * recorded in the audit log.
 */
export interface Promotion {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  code: string;
  name: string;
  type: PromotionType;
  value: number;
  /** Stay dates: check-in must fall within [validFrom, validTo). */
  validFrom: Date;
  validTo: Date;
  minNights: number;
  /** Empty = all room types. */
  roomTypeIds: Types.ObjectId[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const PromotionSchema = new Schema<Promotion>(
  {
    propertyId: objectId(MODEL.Property),
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9_-]{3,30}$/ },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: enumOf(PromotionType),
    value: { type: Number, required: true, min: 0 },
    validFrom: dateOnly(),
    validTo: dateOnly(),
    minNights: { ...count(true, 1), default: 1 },
    roomTypeIds: { type: [{ type: Schema.Types.ObjectId, ref: MODEL.RoomType }], default: [] },
    active: { type: Boolean, default: true },
  },
  baseSchemaOptions(COLLECTION.promotions),
);

PromotionSchema.pre('validate', function () {
  if (this.type === PromotionType.PERCENTAGE && this.value > 100) this.invalidate('value', 'Percentage cannot exceed 100');
  if (this.type === PromotionType.FIXED && !Number.isInteger(this.value)) this.invalidate('value', 'Fixed discount must be in minor units');
  if (this.validTo <= this.validFrom) this.invalidate('validTo', 'validTo must be after validFrom');
});

PromotionSchema.index({ propertyId: 1, code: 1 }, { unique: true });
