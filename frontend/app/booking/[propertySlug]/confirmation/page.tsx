'use client';

import React, { Suspense, useState, useSyncExternalStore } from 'react';
import { useSearchParams, useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/query-state';
import { bookingEngineApi } from '@/lib/api/booking-engine';
import { lastBookingSnapshot, saveLastBooking, subscribeLastBooking } from '@/lib/booking/session';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDate, formatDateShort } from '@/lib/utils/dates';
import { ApiError } from '@/lib/api/client';
import { ReservationStatus } from '@/types';
import { CheckCircle2, Clock, XCircle, BedDouble, Building2, Printer } from 'lucide-react';
import { RememberBooking } from '@/components/booking/RememberBooking';

const POLL_MS = 4000;
const POLL_MAX = 8; // ~32s of waiting for the webhook / capture to land

function Confirmation() {
  const searchParams = useSearchParams();
  const params = useParams();
  const propertySlug = (params?.propertySlug as string) ?? '';
  const code = searchParams.get('code') ?? '';

  // The booking email is kept in sessionStorage (not in the URL). If it is missing, ask for it.
  // undefined on the server / first render, then the stored value (hydration-safe).
  const stored = useSyncExternalStore(subscribeLastBooking, lastBookingSnapshot, () => undefined);
  const ready = stored !== undefined;
  let email: string | null = null;
  try {
    const parsed = stored ? (JSON.parse(stored) as { code: string; email: string }) : null;
    email = parsed && parsed.code === code ? parsed.email : null;
  } catch {
    email = null;
  }
  const [emailInput, setEmailInput] = useState('');

  const [polls, setPolls] = useState(0);
  const query = useQuery({
    queryKey: ['public-booking', code, email],
    queryFn: () => {
      setPolls((n) => n + 1);
      return bookingEngineApi.lookupReservation(code, email as string);
    },
    enabled: !!code && !!email,
    retry: false,
    // Everything on this page comes from the server. While the booking is still PENDING keep polling briefly.
    refetchInterval: (q) => (q.state.data?.status === ReservationStatus.PENDING && q.state.dataUpdateCount < POLL_MAX ? POLL_MS : false),
  });

  if (!code) {
    return <Shell><Alert variant="warning" message="No booking code supplied." /></Shell>;
  }
  if (!ready) return <Shell><Skeleton className="h-64 w-full" /></Shell>;


  if (!email) {
    return (
      <Shell>
        <Card className="p-6 space-y-3">
          <p className="text-sm text-slate-600">Enter the email used for booking <strong>{code}</strong> to view it.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveLastBooking({ code, email: emailInput.trim().toLowerCase() });
            }}
            className="space-y-3"
          >
            <Input label="Booking email" type="email" required value={emailInput} onChange={(e) => setEmailInput(e.target.value)} />
            <Button type="submit">View booking</Button>
          </form>
        </Card>
      </Shell>
    );
  }

  if (query.isLoading) return <Shell><Skeleton className="h-64 w-full" /></Shell>;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Shell>
        {notFound ? <Alert variant="danger" title="Booking not found" message="We could not find a booking with this code and email." /> : <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      </Shell>
    );
  }

  const r = query.data!;
  const confirmed = r.status === ReservationStatus.CONFIRMED || r.status === ReservationStatus.CHECKED_IN || r.status === ReservationStatus.CHECKED_OUT;
  const pending = r.status === ReservationStatus.PENDING;
  const cancelled = r.status === ReservationStatus.CANCELLED;

  return (
    <Shell>
      <div className="text-center space-y-3">
        <div className={`inline-flex h-16 w-16 items-center justify-center rounded-3xl shadow-md ${confirmed ? 'bg-emerald-100 text-emerald-600' : pending ? 'bg-amber-100 text-amber-600' : 'bg-rose-100 text-rose-600'}`}>
          {confirmed ? <CheckCircle2 className="h-10 w-10" /> : pending ? <Clock className="h-10 w-10" /> : <XCircle className="h-10 w-10" />}
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight">{confirmed ? 'Booking Confirmed' : pending ? 'Awaiting payment confirmation' : cancelled ? 'Booking cancelled or expired' : `Booking ${r.status.toLowerCase().replace('_', ' ')}`}</h1>
        {pending && (
          <p className="text-sm text-slate-500">
            We have not received your payment yet.{polls >= POLL_MAX ? ' If you already paid, it can take a few minutes; refresh this page shortly.' : ' Checking…'}
            {r.holdExpiresAt ? ` Your room is held until ${formatDate(r.holdExpiresAt, 'h:mm a')}.` : ''}
          </p>
        )}
        {cancelled && <p className="text-sm text-slate-500">This booking is no longer active. Any payment is refunded to the original method.</p>}
      </div>

      {email && <RememberBooking booking={{ code: r.reservationCode, email, propertyName: r.propertyName, checkIn: r.checkIn, checkOut: r.checkOut }} />}

      <Card className="rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xl overflow-hidden bg-white dark:bg-slate-900">
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 p-6 text-white flex items-center justify-between">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-300">Reservation Voucher</span>
            <div className="text-2xl font-black tracking-tight">{r.reservationCode}</div>
          </div>
          <div className="text-right">
            <span className="text-[10px] text-slate-400 block">Total</span>
            <div className="text-xl font-black text-emerald-400">{formatCurrency(r.total, r.currency)}</div>
            <span className="text-[10px] text-slate-400">{r.paymentStatus.replace(/_/g, ' ')}</span>
          </div>
        </div>
        <CardContent className="p-6 sm:p-8 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-6 border-b border-slate-100 dark:border-slate-800">
            <div>
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Property</span>
              <span className="text-base font-bold flex items-center gap-1.5"><Building2 className="h-4 w-4 text-indigo-600 shrink-0" />{r.propertyName}</span>
            </div>
            <div>
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Rooms</span>
              {r.rooms.map((rm, i) => (
                <div key={i}>
                  <span className="text-base font-bold flex items-center gap-1.5"><BedDouble className="h-4 w-4 text-indigo-600 shrink-0" />{rm.roomTypeName}</span>
                  <span className="text-xs text-slate-500 block">{rm.ratePlan}{rm.cancellationDescription ? ` • ${rm.cancellationDescription}` : ''}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 pb-6 border-b border-slate-100 dark:border-slate-800">
            <div>
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Check-in</span>
              <span className="text-base font-extrabold">{formatDateShort(r.checkIn)}</span>
            </div>
            <div>
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Check-out</span>
              <span className="text-base font-extrabold">{formatDateShort(r.checkOut)}</span>
            </div>
          </div>
          <div className="text-xs space-y-1 text-slate-600">
            <div className="flex justify-between"><span>Room charges</span><span>{formatCurrency(r.subtotal, r.currency)}</span></div>
            {r.discount > 0 && <div className="flex justify-between text-emerald-600"><span>Discount</span><span>-{formatCurrency(r.discount, r.currency)}</span></div>}
            <div className="flex justify-between"><span>Taxes</span><span>{formatCurrency(r.tax, r.currency)}</span></div>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
            <Button variant="outline" className="w-full sm:w-1/2 font-semibold" onClick={() => window.print()}>
              <Printer className="h-4 w-4 mr-2" /> Print / Save Voucher
            </Button>
            <Link href={`/stays/${propertySlug}`} className="w-full sm:w-1/2"><Button className="w-full font-bold">Back to Property</Button></Link>
          </div>
        </CardContent>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 font-sans py-12 px-4 sm:px-6">
      <div className="max-w-2xl mx-auto space-y-6">{children}</div>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense fallback={<Shell><Skeleton className="h-64 w-full" /></Shell>}>
      <Confirmation />
    </Suspense>
  );
}
