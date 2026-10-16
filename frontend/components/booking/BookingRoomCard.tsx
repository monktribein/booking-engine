'use client';

import React, { useState } from 'react';
import { PublicAvailabilityItem } from '@/types';
import { formatCurrency } from '@/lib/utils/currency';
import { Users, Check, Coffee, ArrowRight, ShieldCheck } from 'lucide-react';

const DEFAULT_ROOM_IMAGES: Record<string, string> = {
  standard: '/images/stays/radha-ashram-room.jpg',
  'deluxe-ac': 'https://images.unsplash.com/photo-1582719508461-905c673771fd?auto=format&fit=crop&w=600&q=80',
  deluxe: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?auto=format&fit=crop&w=600&q=80',
  family: 'https://images.unsplash.com/photo-1591088398332-8a7791972843?auto=format&fit=crop&w=600&q=80',
};

export function BookingRoomCard({
  room,
  currency,
  onSelectRatePlan,
}: {
  room: PublicAvailabilityItem;
  currency: string;
  onSelectRatePlan: (room: PublicAvailabilityItem, ratePlanId: string) => void;
}) {
  const [selectedPlanId, setSelectedPlanId] = useState<string>(
    room.ratePlans[0]?.ratePlanId || ''
  );

  const selectedPlan = room.ratePlans.find((rp) => rp.ratePlanId === selectedPlanId) || room.ratePlans[0];

  // Resolve room image or fallback to realistic high-res photo
  const typeKey = room.roomTypeName.toLowerCase().includes('deluxe')
    ? 'deluxe-ac'
    : room.roomTypeName.toLowerCase().includes('family')
    ? 'family'
    : 'standard';
  const defaultPhoto = DEFAULT_ROOM_IMAGES[typeKey] || DEFAULT_ROOM_IMAGES.standard;
  const rawPhoto = room.images?.[0]?.url;
  const photoUrl = !rawPhoto || rawPhoto.includes('.example') ? defaultPhoto : rawPhoto;

  return (
    <div className="rounded-3xl border border-stone-200/90 bg-white p-4 sm:p-5 transition-all hover:border-[#a8c6e5] flex flex-col md:flex-row gap-5 items-stretch md:items-center">
      {/* Compact Room Photo Thumbnail - Matching Image 4 */}
      <div className="relative w-full md:w-56 lg:w-64 h-40 shrink-0 rounded-2xl overflow-hidden bg-stone-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photoUrl}
          alt={room.roomTypeName}
          className="h-full w-full object-cover transition-transform duration-500 hover:scale-105"
          onError={(e) => {
            e.currentTarget.src = defaultPhoto;
          }}
        />
        <div className="absolute top-2.5 left-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-900/80 backdrop-blur-xs px-2.5 py-0.5 text-[10px] font-bold text-white shadow-2xs">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {room.availableRooms} available
          </span>
        </div>
      </div>

      {/* Middle Column: Details, Features & Compact Plan Selector */}
      <div className="flex-1 min-w-0 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">
            {room.roomTypeName}
          </h3>
          <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 border border-stone-200/60">
            <ShieldCheck className="h-3 w-3 text-emerald-600" /> Verified
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 border border-stone-200/60">
            <Users className="h-3 w-3 text-slate-500" /> Fits {room.maxOccupancy} Guests
          </span>
        </div>

        <p className="text-xs text-slate-500 line-clamp-1 leading-relaxed">
          {room.description || `${room.roomTypeName} at Radha Ashram with peaceful amenities.`}
        </p>

        {/* Amenities Chips */}
        <div className="flex flex-wrap gap-1.5">
          {room.amenities.map((amenity, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 rounded-md bg-stone-50 border border-stone-200/70 px-2 py-0.5 text-[10px] font-medium text-slate-700 capitalize"
            >
              <Check className="h-3 w-3 text-emerald-600" />
              {amenity.replace(/-/g, ' ')}
            </span>
          ))}
        </div>

        {/* Streamlined Compact Rate Plan Selector */}
        <div className="pt-1 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-slate-400 mr-0.5">Plan:</span>
          {room.ratePlans.map((plan) => {
            const isSelected = plan.ratePlanId === selectedPlanId;
            return (
              <button
                key={plan.ratePlanId}
                type="button"
                onClick={() => setSelectedPlanId(plan.ratePlanId)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold transition-all cursor-pointer border ${
                  isSelected
                    ? 'bg-[#c1d8f0]/50 border-[#a8c6e5] text-slate-900'
                    : 'bg-stone-50/70 border-stone-200 text-slate-600 hover:bg-stone-100/70'
                }`}
              >
                <span>{plan.name}</span>
                <span className="text-stone-300">•</span>
                <span className="font-bold">{formatCurrency(plan.nightlyPrice, currency)}</span>
                {plan.mealPlan === 'BREAKFAST' && <Coffee className="h-3 w-3 text-amber-600" />}
              </button>
            );
          })}
        </div>

        {!room.bookable && room.reasons.length > 0 && (
          <p className="text-xs text-amber-700">Not bookable for these dates: {room.reasons.join('; ')}</p>
        )}
      </div>

      {/* Right Column: Starts From, Price & Unified Light Blue Book Now Button */}
      <div className="shrink-0 flex md:flex-col items-center md:items-end justify-between md:justify-center gap-2.5 border-t md:border-t-0 md:border-l border-stone-100 pt-3 md:pt-0 md:pl-5 w-full md:w-auto">
        <div className="text-left md:text-right">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">
            Starts From
          </span>
          <div className="text-xl lg:text-2xl font-black text-slate-900 leading-tight">
            {selectedPlan ? formatCurrency(selectedPlan.nightlyPrice, currency) : '-'}
          </div>
          <span className="text-[10px] text-slate-400 block font-normal">per night / room</span>
        </div>

        <button
          type="button"
          disabled={!room.bookable || !selectedPlanId}
          onClick={() => onSelectRatePlan(room, selectedPlanId)}
          className="inline-flex items-center justify-center rounded-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] px-5 py-2 text-xs transition-transform hover:-translate-y-0.5 cursor-pointer whitespace-nowrap shadow-2xs disabled:opacity-50"
        >
          Book Now <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </button>
      </div>
    </div>
  );
}
