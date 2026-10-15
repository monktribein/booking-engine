/**
 * Hard cap on nights per reservation. It keeps the embedded `nightlyRates`
 * arrays bounded and multi-night inventory transactions small.
 */
export const MAX_STAY_NIGHTS = 90;

/** Default number of days ahead that inventory rows are materialised and sellable. */
export const DEFAULT_BOOKING_HORIZON_DAYS = 365;

/** How long an unpaid PENDING direct booking holds inventory. */
export const DEFAULT_PENDING_HOLD_MINUTES = 20;

export const SYNC_LOG_RETENTION_DAYS = 90;
export const SYNC_JOB_SUCCESS_RETENTION_DAYS = 30;

/** Delivered / failed outbound webhook deliveries are kept this long (purged by the scheduler). */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
