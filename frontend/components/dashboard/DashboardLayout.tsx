'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Sparkles } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { OrganizationLocked, PendingApprovalBanner, isLockedStatus } from './OrganizationGate';
import { ReservationModal } from '../reservations/ReservationModal';
import { Skeleton } from '../ui/skeleton';
import { Button } from '../ui/button';
import { useAuth } from '@/lib/auth/auth-context';
import { OrganizationStatus, UserRole } from '@/types';

/** The only dashboard pages a DEVELOPER (API keys and webhooks, no guest or booking data) may open. */
const DEVELOPER_PAGES = ['/dashboard/developers', '/dashboard/profile'];

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading, sessionError, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [reservationModalOpen, setReservationModalOpen] = useState(false);

  const isPlatform = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.OPERATIONS_ADMIN;
  const isDeveloper = user?.role === UserRole.DEVELOPER;

  // No session -> sign-in. The dashboard never renders for an unverified user.
  useEffect(() => {
    if (!isLoading && !user && !sessionError) router.replace('/login');
  }, [isLoading, user, sessionError, router]);

  // Platform staff run the platform from the admin console; developers get the developer tools.
  useEffect(() => {
    if (isPlatform) router.replace('/admin');
    else if (isDeveloper && !DEVELOPER_PAGES.some((p) => pathname.startsWith(p))) router.replace('/dashboard/developers');
  }, [isPlatform, isDeveloper, pathname, router]);

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

  if (!user || isPlatform) return null; // redirecting

  if (isLockedStatus(user.organizationStatus)) return <OrganizationLocked status={user.organizationStatus as OrganizationStatus} />;

  const pending = user.organizationStatus === OrganizationStatus.PENDING_APPROVAL;

  if (isDeveloper) {
    return (
      <div className="min-h-screen bg-slate-50/50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
        <header className="flex h-14 items-center justify-between border-b border-slate-200/80 bg-white px-4 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
          <Link href="/dashboard/developers" className="flex items-center gap-2 text-sm font-bold">
            <Sparkles className="h-4 w-4 text-indigo-600" aria-hidden="true" /> Tirvona Developers
          </Link>
          <div className="flex items-center gap-3 text-xs">
            <Link href="/dashboard/profile" className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">{user.name}</Link>
            <button onClick={() => void logout()} title="Sign Out" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 cursor-pointer">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
          {pending && <PendingApprovalBanner />}
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50/50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <Topbar onMenuClick={() => setSidebarOpen(true)} onNewReservation={() => setReservationModalOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-7xl space-y-6">
            {pending && <PendingApprovalBanner />}
            {children}
          </div>
        </main>
      </div>

      <ReservationModal isOpen={reservationModalOpen} onClose={() => setReservationModalOpen(false)} />
    </div>
  );
}
