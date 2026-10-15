import React from 'react';
import { PmsCalendar } from '@/components/calendar/PmsCalendar';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'PMS Calendar | Tirvona Hospitality PMS',
  description: 'Manage hotel physical rooms, bookings, and channel assignments.',
};

export default function CalendarPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          PMS Room Calendar
        </h1>
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
          Real-time physical room tape-chart with multi-channel reservation distribution and instant blocks.
        </p>
      </div>

      <PmsCalendar />
    </div>
  );
}
