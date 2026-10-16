'use client';

import React, { useState } from 'react';
import { Button } from '../ui/button';
import { Calendar, Users, Search, Tag } from 'lucide-react';

export interface SearchParams {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  promoCode?: string;
}

export function BookingSearch({
  onSearch,
  initialValues,
}: {
  onSearch: (params: SearchParams) => void;
  initialValues?: Partial<SearchParams>;
}) {
  const [checkIn, setCheckIn] = useState(initialValues?.checkIn ?? '');
  const [checkOut, setCheckOut] = useState(initialValues?.checkOut ?? '');
  const [adults, setAdults] = useState(initialValues?.adults || 2);
  const [children, setChildren] = useState(initialValues?.children || 0);
  const [promoCode, setPromoCode] = useState(initialValues?.promoCode || '');

  const today = new Date().toISOString().slice(0, 10);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkIn || !checkOut || checkOut <= checkIn) return;
    onSearch({
      checkIn,
      checkOut,
      adults: Number(adults),
      children: Number(children),
      promoCode: promoCode.trim() || undefined,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200/80 dark:border-slate-800 p-4 sm:p-5"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
        {/* Check-in */}
        <div className="space-y-1">
          <label htmlFor="bs-checkin" className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5 text-indigo-600" /> Check-in Date
          </label>
          <input
            id="bs-checkin"
            type="date"
            required
            min={today}
            value={checkIn}
            onChange={(e) => setCheckIn(e.target.value)}
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100"
          />
        </div>

        {/* Check-out */}
        <div className="space-y-1">
          <label htmlFor="bs-checkout" className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5 text-indigo-600" /> Check-out Date
          </label>
          <input
            id="bs-checkout"
            type="date"
            required
            min={checkIn || today}
            value={checkOut}
            onChange={(e) => setCheckOut(e.target.value)}
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100"
          />
        </div>

        {/* Guests */}
        <div className="space-y-1">
          <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Users className="h-3.5 w-3.5 text-indigo-600" /> Guests
          </label>
          <div className="grid grid-cols-2 gap-2">
            <select
              aria-label="Adults"
              value={adults}
              onChange={(e) => setAdults(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800 px-2 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100"
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'Adult' : 'Adults'}
                </option>
              ))}
            </select>
            <select
              aria-label="Children"
              value={children}
              onChange={(e) => setChildren(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800 px-2 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100"
            >
              {[0, 1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'Child' : 'Kids'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Promo code */}
        <div className="space-y-1">
          <label htmlFor="bs-promo" className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Tag className="h-3.5 w-3.5 text-indigo-600" /> Promo Code
          </label>
          <input
            id="bs-promo"
            type="text"
            placeholder="e.g. RADHA10"
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 placeholder:font-normal"
          />
        </div>

        {/* Submit */}
        <div>
          <button
            type="submit"
            disabled={!checkIn || !checkOut || checkOut <= checkIn}
            className="w-full h-10 inline-flex items-center justify-center rounded-xl font-semibold text-xs text-slate-900 bg-[#c1d8f0] hover:bg-[#acc8e6] border border-[#a8c6e5] transition-all hover:-translate-y-0.5 cursor-pointer shadow-2xs disabled:opacity-50"
          >
            <Search className="h-4 w-4 mr-1.5" /> Check Availability
          </button>
        </div>
      </div>
    </form>
  );
}
