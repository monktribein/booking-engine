/**
 * Currency utilities for Tirvona.
 * All monetary amounts in the backend are stored in minor units (paise for INR, cents for USD).
 * 250000 -> ₹2,500
 */

export function formatCurrency(
  minorUnits: number | undefined | null,
  currency: string = 'INR',
  options: { showDecimals?: boolean; compact?: boolean } = {}
): string {
  if (minorUnits === undefined || minorUnits === null || isNaN(minorUnits)) {
    return currency === 'INR' ? '₹0' : '$0';
  }

  const majorAmount = minorUnits / 100;

  if (currency === 'INR') {
    if (options.compact && majorAmount >= 100000) {
      return `₹${(majorAmount / 100000).toFixed(1)}L`;
    }
    if (options.compact && majorAmount >= 1000) {
      return `₹${(majorAmount / 1000).toFixed(1)}k`;
    }
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: options.showDecimals ? 2 : 0,
      minimumFractionDigits: options.showDecimals ? 2 : 0,
    }).format(majorAmount);
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: options.showDecimals ? 2 : 0,
  }).format(majorAmount);
}

export function fromMajor(major: number): number {
  return Math.round(major * 100);
}

export function toMajor(minor: number): number {
  return Math.round(minor) / 100;
}
