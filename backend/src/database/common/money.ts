/**
 * All monetary amounts are stored as integers in the currency's minor unit
 * (paise for INR, cents for USD). ₹3,500.00 is stored as 350000. Integers
 * keep sums exact, which binary floating point does not. Every money field
 * sits next to an ISO-4217 `currency` field.
 */

export function isMinorAmount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** `percent` of `amount`, rounded half-up to the nearest minor unit. */
export function percentOf(amount: number, percent: number): number {
  return Math.round((amount * percent) / 100);
}

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function fromMajor(major: number): number {
  return Math.round(major * 100);
}
