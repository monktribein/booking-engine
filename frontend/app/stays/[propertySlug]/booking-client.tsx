'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { BookingSearch, SearchParams } from '@/components/booking/BookingSearch';
import { BookingRoomCard } from '@/components/booking/BookingRoomCard';
import { EmptyState, ErrorState } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { PublicAvailabilityItem, PublicRoomType } from '@/types';
import { bookingEngineApi } from '@/lib/api/booking-engine';

export function PublicBookingClient({
  propertySlug,
  currency,
  initialRoomTypes,
  defaultCheckIn,
  defaultCheckOut,
  defaultAdults = 2,
}: {
  propertySlug: string;
  currency: string;
  initialRoomTypes: PublicRoomType[];
  defaultCheckIn: string;
  defaultCheckOut: string;
  defaultAdults?: number;
}) {
  const router = useRouter();
  const [searchParams, setSearchParams] = useState<SearchParams>({ checkIn: defaultCheckIn, checkOut: defaultCheckOut, adults: defaultAdults, children: 0 });

  const query = useQuery({
    queryKey: ['public-availability', propertySlug, searchParams],
    queryFn: () =>
      bookingEngineApi.searchAvailability(propertySlug, { ...searchParams, children: searchParams.children || undefined }, { roomTypes: initialRoomTypes }),
    staleTime: 0,
  });

  const handleSelectRatePlan = (room: PublicAvailabilityItem, ratePlanId: string) => {
    const qs = new URLSearchParams({
      roomTypeId: room.roomTypeId,
      ratePlanId,
      checkIn: searchParams.checkIn,
      checkOut: searchParams.checkOut,
      adults: String(searchParams.adults),
      children: String(searchParams.children),
    });
    if (searchParams.promoCode) qs.set('promo', searchParams.promoCode);
    if (new URLSearchParams(window.location.search).get('via') === 'tirvona') qs.set('via', 'tirvona');
    router.push(`/booking/${propertySlug}?${qs.toString()}`);
  };

  return (
    <div className="space-y-8">
      {/* Search box reveals on scroll */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.2 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        <BookingSearch onSearch={setSearchParams} initialValues={searchParams} />
      </motion.div>

      {query.isLoading && (
        <div className="space-y-4" aria-busy="true" aria-live="polite">
          <p className="text-xs text-slate-500 font-semibold text-center">Checking live availability and rates…</p>
          <Skeleton className="h-44 w-full rounded-3xl" />
        </div>
      )}

      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.isSuccess && (
        <div className="space-y-6">
          {query.data.length === 0 ? (
            <EmptyState title="No rooms available" hint="Try different dates or fewer guests." />
          ) : (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                className="text-xs text-slate-500 font-medium"
              >
                {query.data.filter((r) => r.bookable).length} of {query.data.length} room types bookable for {searchParams.checkIn} to {searchParams.checkOut}
              </motion.div>
              <div className="space-y-5">
                {query.data.map((room, idx) => (
                  <motion.div
                    key={room.roomTypeId}
                    initial={{ opacity: 0, y: 35 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.15 }}
                    transition={{
                      duration: 0.45,
                      delay: idx * 0.1,
                      ease: 'easeOut',
                    }}
                  >
                    <BookingRoomCard room={room} currency={currency} onSelectRatePlan={handleSelectRatePlan} />
                  </motion.div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
