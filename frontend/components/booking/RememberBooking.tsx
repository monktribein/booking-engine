'use client';

import React, { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { forgetBooking, recentBookingsSnapshot, rememberBooking, subscribeRecentBookings, type RecentBooking } from '@/lib/booking/recent';

/** Opt-in "keep this booking on this device" control, shown for a booking the guest has just opened. */
export function RememberBooking({ booking }: { booking: Omit<RecentBooking, 'savedAt'> }) {
  const snapshot = useSyncExternalStore(subscribeRecentBookings, recentBookingsSnapshot, () => '[]');
  const remembered = snapshot.includes(`"${booking.code}"`);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs dark:border-slate-800 dark:bg-slate-900">
      <span className="text-slate-600 dark:text-slate-300">
        {remembered ? 'This booking is saved on this device. Anyone using this browser can open it.' : 'Save this booking on this device to find it again without typing the code.'}
      </span>
      <Button variant="outline" size="sm" onClick={() => (remembered ? forgetBooking(booking.code) : rememberBooking(booking))}>
        {remembered ? 'Forget' : 'Save on this device'}
      </Button>
    </div>
  );
}
