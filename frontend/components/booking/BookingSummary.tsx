import React from 'react';
import { Card, CardContent } from '../ui/card';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDateShort, calculateNights } from '@/lib/utils/dates';
import { BedDouble, Calendar, Users, ShieldCheck, Tag } from 'lucide-react';

/**
 * Shows the quote exactly as the server priced it (availability endpoint). The browser never recomputes
 * tax or discounts, so what the guest sees is what the server will charge.
 */
export function BookingSummaryCard({
  propertyName,
  roomTypeName,
  ratePlanName,
  checkIn,
  checkOut,
  adults,
  childCount = 0,
  currency,
  nightly,
  subtotal,
  discount,
  tax,
  total,
  holdNote,
}: {
  propertyName: string;
  roomTypeName: string;
  ratePlanName: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  childCount?: number;
  currency: string;
  nightly: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  holdNote?: string;
}) {
  const nights = calculateNights(checkIn, checkOut);

  return (
    <Card className="rounded-2xl border border-slate-200/90 dark:border-slate-800 shadow-md bg-white dark:bg-slate-900 overflow-hidden sticky top-20">
      <div className="p-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Booking Summary</span>
        <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-0.5">{propertyName}</h3>
      </div>

      <CardContent className="p-5 space-y-4 text-xs">
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <BedDouble className="h-4 w-4 text-indigo-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <span className="font-bold text-slate-900 dark:text-slate-100">{roomTypeName}</span>
              <span className="text-slate-400 block text-[11px]">{ratePlanName}</span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Calendar className="h-4 w-4 text-indigo-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {formatDateShort(checkIn)} - {formatDateShort(checkOut)}
              </span>
              <span className="text-slate-400 block text-[11px]">{nights} {nights === 1 ? 'Night' : 'Nights'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-indigo-600 shrink-0" aria-hidden="true" />
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {adults} Adults {childCount > 0 ? `• ${childCount} Children` : ''}
            </span>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
          <div className="flex justify-between text-slate-600 dark:text-slate-400">
            <span>{formatCurrency(nightly, currency)} × {nights} nights</span>
            <span>{formatCurrency(subtotal, currency)}</span>
          </div>
          {discount > 0 && (
            <div className="flex justify-between text-emerald-600 font-semibold">
              <span className="flex items-center gap-1"><Tag className="h-3 w-3" /> Promotion</span>
              <span>-{formatCurrency(discount, currency)}</span>
            </div>
          )}
          <div className="flex justify-between text-slate-600 dark:text-slate-400">
            <span>Taxes</span>
            <span>{formatCurrency(tax, currency)}</span>
          </div>
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-between items-baseline font-bold text-sm text-slate-900 dark:text-slate-100">
            <span>Total</span>
            <span className="text-lg text-indigo-600 dark:text-indigo-400">{formatCurrency(total, currency)}</span>
          </div>
        </div>

        {holdNote && (
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3 space-y-1 text-[11px] text-slate-500">
            <div className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300">
              <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              Your room is held
            </div>
            <p>{holdNote}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
