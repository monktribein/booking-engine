'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { ReservationModal } from '../reservations/ReservationModal';
import { Skeleton } from '../ui/skeleton';
import { Button } from '../ui/button';
import { useAuth } from '@/lib/auth/auth-context';

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, isLoading, sessionError } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [reservationModalOpen, setReservationModalOpen] = useState(false);

  // No session -> sign-in. The dashboard never renders for an unverified user.
  useEffect(() => {
    if (!isLoading && !user && !sessionError) router.replace('/login');
  }, [isLoading, user, sessionError, router]);

  if (isLoading) {
    return (
      <div className="p-8 space-y-4" aria-busy="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!user && sessionError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" role="alert">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-lg font-bold">We could not verify your session</h1>
          <p className="text-sm text-slate-500">{sessionError.status === 0 ? 'The server cannot be reached.' : 'The server had a problem.'} Your login is unchanged.</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!user) return null; // redirecting to /login

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50/50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <Topbar onMenuClick={() => setSidebarOpen(true)} onNewReservation={() => setReservationModalOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-7xl space-y-6">{children}</div>
        </main>
      </div>

      <ReservationModal isOpen={reservationModalOpen} onClose={() => setReservationModalOpen(false)} />
    </div>
  );
}
