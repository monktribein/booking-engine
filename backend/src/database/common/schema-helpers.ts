import { Schema } from 'mongoose';
import { isDateOnly } from './dates';
import { isMinorAmount } from './money';

/**
 * Options shared by every schema.
 *  - strict: 'throw'       unknown fields in a write are an error, not silently dropped.
 *  - strictQuery: 'throw'  unknown fields in a filter are an error. The alternative,
 *                          silently stripping them, can turn a typo'd filter into
 *                          "match everything", which is dangerous in deleteMany/updateMany.
 */
export function baseSchemaOptions(collection: string, timestamps: 'full' | 'createdOnly' = 'full') {
  return {
    collection,
    strict: 'throw' as const,
    strictQuery: 'throw' as const,
    timestamps: timestamps === 'full' ? true : { createdAt: true, updatedAt: false },
    minimize: false,
    id: false,
    toJSON: { versionKey: false },
    toObject: { versionKey: false },
  };
}

export const objectId = (ref: string, required = true) => ({
  type: Schema.Types.ObjectId,
  ref,
  required,
  ...(required ? {} : { default: null }),
});

export const money = (required = true) => ({
  type: Number,
  required,
  default: required ? undefined : 0,
  validate: { validator: isMinorAmount, message: '{PATH} must be a non-negative integer in minor currency units' },
});

export const count = (required = true, min = 0) => ({
  type: Number,
  required,
  min,
  validate: { validator: (v: number | null) => v == null || Number.isInteger(v), message: '{PATH} must be an integer' },
});

export const currency = () => ({
  type: String,
  required: true,
  uppercase: true,
  trim: true,
  match: [/^[A-Z]{3}$/, '{PATH} must be an ISO-4217 currency code'] as [RegExp, string],
});

export const dateOnly = (required = true) => ({
  type: Date,
  required,
  validate: { validator: (v: Date | null) => v == null || isDateOnly(v), message: '{PATH} must be a calendar date at 00:00Z' },
});

export const slug = () => ({
  type: String,
  required: true,
  trim: true,
  lowercase: true,
  maxlength: 80,
  match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '{PATH} must be a kebab-case slug'] as [RegExp, string],
});

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const E164_RE = /^\+[1-9]\d{6,14}$/;
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const email = (required = false) => ({
  type: String,
  required,
  trim: true,
  lowercase: true,
  maxlength: 254,
  match: [EMAIL_RE, '{PATH} is not a valid email'] as [RegExp, string],
});

export const phone = (required = false) => ({
  type: String,
  required,
  trim: true,
  match: [E164_RE, '{PATH} must be in E.164 format, e.g. +919876543210'] as [RegExp, string],
});

export const enumOf = <E extends string>(e: Record<string, E>, required = true, defaultValue?: E) => ({
  type: String,
  enum: Object.values(e),
  required,
  ...(defaultValue !== undefined ? { default: defaultValue } : {}),
});

export const boundedArray = (max: number) => ({
  validator: (v: unknown[]) => !v || v.length <= max,
  message: `{PATH} cannot contain more than ${max} items`,
});

export const ImageSchema = new Schema(
  {
    url: { type: String, required: true, trim: true, maxlength: 2048, match: /^https:\/\// },
    caption: { type: String, trim: true, maxlength: 200 },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false, strict: 'throw', versionKey: false },
);

/** True for a MongoDB duplicate-key error, including ones surfaced by bulk writes. */
export function isDuplicateKeyError(err: unknown): err is { code: 11000; keyPattern?: Record<string, number>; keyValue?: Record<string, unknown> } {
  const e = err as { code?: number; writeErrors?: { code?: number }[]; errorResponse?: { code?: number } };
  return e?.code === 11000 || e?.errorResponse?.code === 11000 || !!e?.writeErrors?.some((w) => w.code === 11000);
}
