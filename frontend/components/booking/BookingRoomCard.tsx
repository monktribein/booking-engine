'use client';

import React, { useState } from 'react';
import { Card } from '../ui/card';
import { Button } from '../ui/button';
import { PublicAvailabilityItem } from '@/types';
import { formatCurrency } from '@/lib/utils/currency';
import { Users, Check, Coffee, ArrowRight } from 'lucide-react';

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
  const photoUrl = room.images?.[0]?.url;

  return (
    <Card className="overflow-hidden border border-slate-200/90 dark:border-slate-800 shadow-sm hover:shadow-lg transition-all rounded-2xl bg-white dark:bg-slate-900 flex flex-col md:flex-row">
      {/* Room Photo Column */}
      <div className="relative md:w-2/5 min-h-[220px] bg-slate-100 overflow-hidden">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl} alt={room.roomTypeName} className="h-full w-full object-cover transition-transform duration-500 hover:scale-105" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-slate-200 to-slate-100 dark:from-slate-800 dark:to-slate-900" aria-hidden="true" />
        )}
        <div className="absolute top-3 left-3">
          <span className="rounded-full bg-slate-900/80 backdrop-blur-xs px-2.5 py-1 text-[11px] font-bold text-white shadow-xs">
            {room.availableRooms} left for these dates
          </span>
        </div>
      </div>

      {/* Details Column */}
      <div className="flex-1 p-5 sm:p-6 flex flex-col justify-between space-y-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                {room.roomTypeName}
              </h3>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5">
                <Users className="h-3.5 w-3.5 text-indigo-600" />
                <span>Fits up to {room.maxOccupancy} Guests</span>
              </div>
            </div>

            <div className="text-right">
              <div className="text-xl sm:text-2xl font-black text-slate-900 dark:text-slate-100">
                {selectedPlan ? formatCurrency(selectedPlan.nightlyPrice, currency) : '-'}
              </div>
              <span className="text-[10px] text-slate-400 block font-medium">per night • taxes extra</span>
            </div>
          </div>

          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            {room.description}
          </p>

          {/* Amenities Pills */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {room.amenities.map((amenity, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-300"
              >
                <Check className="h-3 w-3 text-emerald-600" />
                {amenity}
              </span>
            ))}
          </div>
        </div>

        {/* Rate Plans Selection Box */}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">
            Choose Rate & Meal Plan
          </span>

          <div className="space-y-2">
            {room.ratePlans.map((plan) => {
              const isSelected = plan.ratePlanId === selectedPlanId;

              return (
                <div
                  key={plan.ratePlanId}
                  onClick={() => setSelectedPlanId(plan.ratePlanId)}
                  className={`flex items-center justify-between p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                    isSelected
                      ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200 shadow-2xs'
                      : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`plan_${room.roomTypeId}`}
                      checked={isSelected}
                      onChange={() => setSelectedPlanId(plan.ratePlanId)}
                      className="text-indigo-600"
                    />
                    <div>
                      <div className="font-bold flex items-center gap-1.5">
                        {plan.name}
                        {plan.mealPlan === 'BREAKFAST' && (
                          <Coffee className="h-3.5 w-3.5 text-amber-600" />
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">
                        {plan.cancellationDescription}
                      </div>
                    </div>
                  </div>

                  <div className="text-right font-bold text-slate-900 dark:text-slate-100">
                    {formatCurrency(plan.nightlyPrice, currency)}
                    {plan.discountAmount > 0 && (
                      <span className="text-[10px] font-semibold text-emerald-600 block">
                        Saved {formatCurrency(plan.discountAmount, currency)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {!room.bookable && room.reasons.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">Not bookable for these dates: {room.reasons.join('; ')}</p>
        )}

        {/* Action Button */}
        <div className="pt-2 flex justify-end">
          <Button
            size="md"
            disabled={!room.bookable || !selectedPlanId}
            onClick={() => onSelectRatePlan(room, selectedPlanId)}
            className="w-full sm:w-auto font-bold bg-indigo-600 hover:bg-indigo-700 text-white shadow-md px-6"
          >
            Book Now <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
