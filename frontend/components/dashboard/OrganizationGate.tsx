'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, ShieldAlert } from 'lucide-react';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { OrganizationStatus } from '@/types';
import { organizationApi } from '@/lib/api/partners';
import { useAuth } from '@/lib/auth/auth-context';

const LOCKED: OrganizationStatus[] = [OrganizationStatus.REJECTED, OrganizationStatus.SUSPENDED, OrganizationStatus.ARCHIVED];

export const isLockedStatus = (s?: OrganizationStatus | null) => !!s && LOCKED.includes(s);

/** Shown above every dashboard page while the platform has not approved the organization yet. */
export function PendingApprovalBanner() {
  return (
    <Alert
      variant="info"
      title="Your organization is waiting for approval"
      message="You can set up your property, rooms and rates now. Publishing your booking page, the marketplace, API keys, webhooks and channel requests unlock when the Tirvona team approves your organization."
    />
  );
}

/** Replaces the whole dashboard when the platform has rejected or suspended the organization. The reason is read from the API. */
export function OrganizationLocked({ status }: { status: OrganizationStatus }) {
  const { logout } = useAuth();
  const org = useQuery({ queryKey: ['organization', 'me'], queryFn: organizationApi.me });
  const title = status === OrganizationStatus.REJECTED ? 'Your registration was not approved' : status === OrganizationStatus.SUSPENDED ? 'Your organization is suspended' : 'Your organization is archived';
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
      <div className="max-w-md space-y-4 text-center" role="alert">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/50">
          <ShieldAlert className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{title}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {org.data?.statusReason ? <>Reason given: <span className="font-medium">{org.data.statusReason}</span></> : 'Your access is paused.'} Bookings that already exist are not affected. Contact Tirvona support to continue.
        </p>
        <Button variant="outline" onClick={() => void logout()}>Sign out</Button>
      </div>
    </div>
  );
}

export function PendingBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
      <Clock className="h-3 w-3" aria-hidden="true" /> Pending approval
    </span>
  );
}
