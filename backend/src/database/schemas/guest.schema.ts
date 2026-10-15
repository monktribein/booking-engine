import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL } from '../constants';
import { ENCRYPTED_SECRET_RE } from '../common/crypto';
import { baseSchemaOptions, boundedArray, email, enumOf, objectId, phone } from '../common/schema-helpers';
import { GuestDocumentType } from '../enums';

export interface GuestDocument {
  type: GuestDocumentType;
  /** Full document number, AES-GCM encrypted. Only the last 4 characters are kept in clear. */
  numberEncrypted?: string;
  numberLast4?: string;
  issuingCountry?: string;
  expiresAt?: Date;
  /** Object-storage key (private bucket) for the scan. Never a public URL. */
  fileKey?: string;
  verifiedAt?: Date;
}

const GuestDocumentSchema = new Schema<GuestDocument>(
  {
    type: enumOf(GuestDocumentType),
    numberEncrypted: { type: String, match: ENCRYPTED_SECRET_RE, select: false },
    numberLast4: { type: String, maxlength: 4 },
    issuingCountry: { type: String, uppercase: true, match: /^[A-Z]{2}$/ },
    expiresAt: { type: Date },
    fileKey: { type: String, maxlength: 500 },
    verifiedAt: { type: Date },
  },
  { _id: true, strict: 'throw', versionKey: false },
);

/**
 * Guests are scoped to a property (the hotel's guest book), not shared across
 * tenants, which keeps PII inside the tenant that collected it. Reservations
 * keep a snapshot of the guest's name and contact so history survives edits.
 */
export interface Guest {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  country?: string;
  documents: GuestDocument[];
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const GuestSchema = new Schema<Guest>(
  {
    propertyId: objectId(MODEL.Property),
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, trim: true, maxlength: 100, default: '' },
    email: email(),
    phone: phone(),
    country: { type: String, uppercase: true, trim: true, match: /^[A-Z]{2}$/ },
    documents: { type: [GuestDocumentSchema], default: [], validate: boundedArray(10) },
    notes: { type: String, trim: true, maxlength: 5000 },
  },
  baseSchemaOptions(COLLECTION.guests),
);

// Returning-guest lookup at booking time. Partial, so guests without an email add no index entries.
GuestSchema.index({ propertyId: 1, email: 1 }, { partialFilterExpression: { email: { $type: 'string' } } });
GuestSchema.index({ propertyId: 1, phone: 1 }, { partialFilterExpression: { phone: { $type: 'string' } } });
// Name search belongs in Atlas Search (docs/DATABASE.md §20), not a B-tree index.
