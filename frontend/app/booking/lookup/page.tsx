'use client';

import React, { useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { bookingEngineApi } from '@/lib/api/booking-engine';
import { ApiError } from '@/lib/api/client';
import { PublicReservationView } from '@/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDateShort } from '@/lib/utils/dates';
import { errorMessage } from '@/lib/utils/errors';
import { Search, ArrowLeft } from 'lucide-react';
import { RememberBooking } from '@/components/booking/RememberBooking';
import { forgetAllBookings, forgetBooking, listRecentBookings, recentBookingsSnapshot, subscribeRecentBookings } from '@/lib/booking/recent';

export default function BookingLookupPage() {
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const busy = useRef(false);
  const [reservation, setReservation] = useState<PublicReservationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looked, setLooked] = useState<{ code: string; email: string } | null>(null);

  // Bookings the guest chose to keep on this device (opt-in, see lib/booking/recent.ts). The snapshot string drives re-rendering.
  const savedSnapshot = useSyncExternalStore(subscribeRecentBookings, recentBookingsSnapshot, () => '[]');
  const saved = React.useMemo(() => listRecentBookings(), [savedSnapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const lookup = async (lookupCode: string, lookupEmail: string) => {
    if (busy.current) return;
    busy.current = true;
    setIsLoading(true);
    setError(null);
    setReservation(null);
    setLooked(null);
    try {
      const found = await bookingEngineApi.lookupReservation(lookupCode.trim().toUpperCase(), lookupEmail.trim().toLowerCase());
      setReservation(found);
      setLooked({ code: found.reservationCode, email: lookupEmail.trim().toLowerCase() });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'No booking matches this code and email.' : errorMessage(err));
    } finally {
      busy.current = false;
      setIsLoading(false);
    }
  };

  const handleLookup = (e: React.FormEvent) => {
    e.preventDefault();
    void lookup(code, email);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 font-sans py-12 px-4 sm:px-6">
      <div className="max-w-xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 mb-2">
            <ArrowLeft className="h-4 w-4" /> Home
          </Link>
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-md mx-auto">
            <Search className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Find Your Reservation</h1>
          <p className="text-xs text-slate-500">Enter your booking code and the email used to book.</p>
        </div>

        <Card className="shadow-lg border-slate-200/80 dark:border-slate-800">
          <CardContent className="p-6">
            <form onSubmit={handleLookup} className="space-y-4">
              {error && <Alert variant="danger" message={error} />}
              <Input label="Booking Code *" required placeholder="e.g. TRV-ABCD1234" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
              <Input label="Booking Email Address *" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button type="submit" className="w-full font-bold" isLoading={isLoading} disabled={isLoading}>Lookup Booking</Button>
            </form>
          </CardContent>
        </Card>

        {saved.length > 0 && (
          <Card className="shadow-sm border-slate-200 dark:border-slate-800">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold">Saved on this device</h2>
                <Button variant="ghost" size="sm" onClick={() => forgetAllBookings()}>Forget all</Button>
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {saved.map((b) => (
                  <li key={b.code} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{b.propertyName}</div>
                      <div className="text-slate-500">{b.code} • {formatDateShort(b.checkIn)} to {formatDateShort(b.checkOut)}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={isLoading} onClick={() => void lookup(b.code, b.email)}>View</Button>
                      <Button size="sm" variant="ghost" aria-label={`Forget ${b.code}`} onClick={() => forgetBooking(b.code)}>Forget</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {reservation && looked && (
          <RememberBooking booking={{ code: looked.code, email: looked.email, propertyName: reservation.propertyName, checkIn: reservation.checkIn, checkOut: reservation.checkOut }} />
        )}

        {reservation && (
          <Card className="shadow-md border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="bg-slate-900 p-4 text-white flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">{reservation.status.replace(/_/g, ' ')}</span>
                <div className="text-xl font-black">{reservation.reservationCode}</div>
              </div>
              <div className="text-right font-bold text-lg">{formatCurrency(reservation.total, reservation.currency)}</div>
            </div>
            <CardContent className="p-5 space-y-3 text-xs">
              <Row label="Property" value={reservation.propertyName} />
              <Row label="Rooms" value={reservation.rooms.map((r) => r.roomTypeName).join(', ')} />
              <Row label="Stay" value={`${formatDateShort(reservation.checkIn)} to ${formatDateShort(reservation.checkOut)} (${reservation.nights} night${reservation.nights === 1 ? '' : 's'})`} />
              <Row label="Payment" value={reservation.paymentStatus.replace(/_/g, ' ')} />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
      <span className="text-slate-400">{label}</span>
      <span className="font-semibold text-slate-800 dark:text-slate-200 text-right">{value}</span>
    </div>
  );
}
