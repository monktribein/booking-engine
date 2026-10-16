import { sql } from 'kysely';

/**
 * The single definition of "who may the public see and book". Every public read and every public booking uses one of
 * these predicates, so a hidden, suspended or unapproved property cannot be reached by guessing a slug.
 *
 * Use inside a query that selects from `properties` (unaliased).
 */

/** The partner organization is approved and running. */
const ORG_ACTIVE = sql`exists (select 1 from organizations o where o.id = properties.organization_id and o.status = 'ACTIVE')`;

/**
 * Bookable through the public booking engine (`/public/properties/:slug`, `/booking/:slug`): the organization is approved,
 * the property is ACTIVE (a platform-SUSPENDED property is not) and the owner published it, either by turning on its own
 * booking page or by being approved on the marketplace.
 */
export const PUBLICLY_BOOKABLE = sql<boolean>`(properties.status = 'ACTIVE' and ${ORG_ACTIVE} and (properties.direct_booking_enabled or properties.marketplace_status = 'APPROVED'))`;

/** Listed in marketplace search: owner consent + platform approval + approved organization + ACTIVE property. */
export const MARKETPLACE_LISTED = sql<boolean>`(properties.status = 'ACTIVE' and ${ORG_ACTIVE} and properties.marketplace_status = 'APPROVED')`;

/** A partner's own software (API key) may operate a property whenever the organization is approved and the property ACTIVE. */
export const PARTNER_OPERABLE = sql<boolean>`(properties.status = 'ACTIVE' and ${ORG_ACTIVE})`;
