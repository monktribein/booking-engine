'use client';

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BookingSummaryCard } from '@/components/booking/BookingSummary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/query-state';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ApiError } from '@/lib/api/client';
import { bookingEngineApi } from '@/lib/api/booking-engine';
import { paymentsApi } from '@/lib/api/payments';
import { openRazorpayCheckout, RazorpaySuccess } from '@/lib/payments/razorpay-checkout';
import { idempotencyKeyFor, saveLastBooking } from '@/lib/booking/session';
import { errorMessage } from '@/lib/utils/errors';
import { formatDate } from '@/lib/utils/dates';
import { CheckoutParams, PublicReservationView, ReservationStatus } from '@/types';
import { ArrowLeft, CreditCard, Lock, Sparkles, User } from 'lucide-react';

type Phase =
  | 'details' // filling the guest form
  | 'creating' // POST /public/reservations in flight
  | 'awaiting-payment' // hold exists, Razorpay Checkout open or ready to (re)open
  | 'verifying' // POST /payments/verify in flight
  | 'verify-failed' // checkout finished but the server could not confirm it; safe to retry
  | 'expired'; // hold ran out

function useCountdown(expiresAt?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, new Date(expiresAt).getTime() - now);
}

function Checkout() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const propertySlug = (params?.propertySlug as string) ?? '';
  const roomTypeId = searchParams.get('roomTypeId') ?? '';
  const ratePlanId = searchParams.get('ratePlanId') ?? '';
  const checkIn = searchParams.get('checkIn') ?? '';
  const checkOut = searchParams.get('checkOut') ?? '';
  const adults = Number(searchParams.get('adults') || 0);
  const children = Number(searchParams.get('children') || 0);
  const promoCode = searchParams.get('promo') || undefined;
  const source = searchParams.get('via') === 'tirvona' ? ('TIRVONA' as const) : undefined;
  const hasSelection = !!(roomTypeId && ratePlanId && checkIn && checkOut && adults > 0);

  // Server-side quote for exactly this selection
  const property = useQuery({
    queryKey: ['public-property', propertySlug],
    queryFn: () => bookingEngineApi.getPublicProperty(propertySlug),
    enabled: hasSelection,
  });
  const quote = useQuery({
    queryKey: ['public-quote', propertySlug, roomTypeId, ratePlanId, checkIn, checkOut, adults, children, promoCode],
    queryFn: () => bookingEngineApi.searchAvailability(propertySlug, { checkIn, checkOut, adults, children, promoCode }, property.data),
    enabled: hasSelection && !!property.data,
    staleTime: Infinity, // priced once; the hold we create would otherwise lower availability and change the quote under the guest
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const room = quote.data?.find((r) => r.roomTypeId === roomTypeId);
  const plan = room?.ratePlans.find((p) => p.ratePlanId === ratePlanId);

  const [rawPhase, setPhase] = useState<Phase>('details');
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', specialRequests: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reservation, setReservation] = useState<PublicReservationView | null>(null);
  const [checkout, setCheckout] = useState<CheckoutParams | null>(null);
  const lock = useRef(false);
  const pendingVerification = useRef<RazorpaySuccess | null>(null);

  const remainingMs = useCountdown(rawPhase === 'awaiting-payment' || rawPhase === 'verify-failed' ? reservation?.holdExpiresAt : undefined);
  // Derived, not stored: once the countdown reaches zero the hold is over, whatever the checkout window is doing.
  const phase: Phase = remainingMs === 0 && (rawPhase === 'awaiting-payment' || rawPhase === 'verify-failed') ? 'expired' : rawPhase;

  const bookingPayload = useMemo(
    () => ({
      propertySlug,
      source,
      roomTypeId,
      ratePlanId,
      quantity: 1,
      checkIn,
      checkOut,
      adults,
      children,
      promoCode,
      guest: { firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim().toLowerCase(), phone: form.phone.replace(/[\s-]/g, '') },
      specialRequests: form.specialRequests.trim() || undefined,
    }),
    [propertySlug, source, roomTypeId, ratePlanId, checkIn, checkOut, adults, children, promoCode, form]
  );

  const goToConfirmation = (code: string) => router.push(`/booking/${propertySlug}/confirmation?code=${encodeURIComponent(code)}`);

  const verify = async (res: RazorpaySuccess) => {
    pendingVerification.current = res;
    setPhase('verifying');
    setError(null);
    try {
      // The server checks the HMAC signature; only then is the payment captured and the booking confirmed.
      const out = await paymentsApi.verifyCheckout({
        razorpayOrderId: res.razorpay_order_id,
        razorpayPaymentId: res.razorpay_payment_id,
        razorpaySignature: res.razorpay_signature,
      });
      pendingVerification.current = null;
      goToConfirmation(out.reservation?.reservationCode ?? reservation!.reservationCode);
    } catch (e) {
      setPhase('verify-failed');
      setError(`We could not confirm your payment yet: ${errorMessage(e)} You have not been charged twice; retrying is safe.`);
    }
  };

  const openCheckout = async (params: CheckoutParams) => {
    setError(null);
    setNotice(null);
    setPhase('awaiting-payment');
    try {
      await openRazorpayCheckout(params, property.data?.name ?? 'Tirvona', {
        onSuccess: (r) => void verify(r),
        onDismiss: () => setNotice('Payment was not completed. Your room is still held; you can pay again before the timer runs out.'),
        onFailure: (msg) => setError(`${msg} You can try again before the hold expires.`),
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleReserve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lock.current || !plan) return; // block duplicate submits
    lock.current = true;
    setPhase('creating');
    setError(null);
    setNotice(null);
    try {
      const key = idempotencyKeyFor(bookingPayload);
      const result = await bookingEngineApi.createBooking({ ...bookingPayload, expectedTotal: plan.totalPrice }, key); // the total the guest is looking at
      setReservation(result.reservation);
      saveLastBooking({ code: result.reservation.reservationCode, email: bookingPayload.guest.email });
      if (result.reservation.status === ReservationStatus.CONFIRMED) {
        goToConfirmation(result.reservation.reservationCode); // server did not require online payment
        return;
      }
      if (!result.payment) {
        setPhase('details');
        setError('Your booking was created but online payment could not be started. Please contact the property with your booking code ' + result.reservation.reservationCode + '.');
        return;
      }
      setCheckout(result.payment);
      await openCheckout(result.payment);
    } catch (err) {
      setPhase('details'); // form values are kept; retrying reuses the same idempotency key
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED') {
        // Nothing was held. Show the guest the price the server calculates now and let them decide.
        await quote.refetch();
        setError('The price changed while you were booking. The summary now shows the current total; please review it and reserve again.');
      } else {
        setError(errorMessage(err));
      }
    } finally {
      lock.current = false;
    }
  };

  if (!hasSelection) {
    return (
      <div className="max-w-md mx-auto py-24 px-4 text-center space-y-4">
        <p className="text-sm text-slate-600">Choose a room and dates first.</p>
        <Link href={`/stays/${propertySlug}`}><Button>Back to rooms</Button></Link>
      </div>
    );
  }

  const holdText = remainingMs !== null && remainingMs > 0 ? `${Math.floor(remainingMs / 60000)}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0')} left` : undefined;
  const busy = phase === 'creating' || phase === 'verifying';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 font-sans text-slate-900 dark:text-slate-100">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href={`/stays/${propertySlug}`} className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900">
            <ArrowLeft className="h-4 w-4" /> Back to Rooms
          </Link>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600" aria-hidden="true" />
            <span className="font-bold text-sm">Secure Guest Checkout</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-emerald-700 font-semibold">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Payments by Razorpay
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            {(property.isError || quote.isError) && <ErrorState error={property.error ?? quote.error} onRetry={() => { void property.refetch(); void quote.refetch(); }} />}
            {quote.isSuccess && !plan && !reservation && (
              <Alert variant="warning" title="This option is no longer available" message="The room or rate you chose cannot be booked for these dates. Please go back and search again." />
            )}
            {room && !room.bookable && <Alert variant="warning" title="Not bookable for these dates" message={room.reasons.join('; ') || 'A restriction applies to this stay.'} />}

            {phase === 'expired' && (
              <Alert variant="danger" title="Your hold has expired" message="The room was released. If you were charged, the amount is refunded automatically. Please search again to book." action={{ label: 'Search again', onClick: () => router.push(`/stays/${propertySlug}`) }} />
            )}
            {error && <Alert variant="danger" message={error} />}
            {notice && <Alert variant="info" message={notice} />}

            {(phase === 'awaiting-payment' || phase === 'verify-failed' || phase === 'verifying') && reservation && (
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base font-bold flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-indigo-600" aria-hidden="true" /> Complete your payment
                  </CardTitle>
                  <CardDescription>
                    Booking {reservation.reservationCode}
                    {reservation.holdExpiresAt ? ` • held until ${formatDate(reservation.holdExpiresAt, 'h:mm a')}` : ''}
                    {holdText ? ` (${holdText})` : ''}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6 pt-2 flex flex-wrap gap-3">
                  {phase === 'verify-failed' ? (
                    <Button onClick={() => pendingVerification.current && void verify(pendingVerification.current)} className="font-bold">Retry confirmation</Button>
                  ) : (
                    <Button isLoading={phase === 'verifying'} disabled={phase === 'verifying' || !checkout} onClick={() => checkout && void openCheckout(checkout)} className="font-bold">
                      <Lock className="h-4 w-4 mr-1.5" /> {phase === 'verifying' ? 'Confirming payment…' : 'Pay now'}
                    </Button>
                  )}
                  <Link href={`/booking/lookup`} className="text-xs text-slate-500 underline self-center">Look up this booking later</Link>
                </CardContent>
              </Card>
            )}

            {(phase === 'details' || phase === 'creating') && (
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base font-bold flex items-center gap-2">
                    <User className="h-4 w-4 text-indigo-600" aria-hidden="true" /> Guest details
                  </CardTitle>
                  <CardDescription>Your confirmation is sent to this contact.</CardDescription>
                </CardHeader>
                <CardContent className="p-6 pt-2">
                  <form onSubmit={handleReserve} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input label="First Name *" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} autoComplete="given-name" />
                      <Input label="Last Name *" required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} autoComplete="family-name" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input label="Phone (with country code) *" type="tel" required placeholder="+919876543210" pattern="\+?[0-9\s\-]{8,20}" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" helperText="Example: +919876543210" />
                      <Input label="Email *" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
                    </div>
                    <Input label="Special requests" value={form.specialRequests} maxLength={1000} onChange={(e) => setForm({ ...form, specialRequests: e.target.value })} />
                    <div className="pt-3 flex justify-end">
                      <Button type="submit" size="md" className="font-bold" isLoading={phase === 'creating'} disabled={busy || !plan || (room ? !room.bookable : true)}>
                        <Lock className="h-4 w-4 mr-1.5" /> Reserve & pay
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="lg:col-span-1">
            {quote.isLoading || property.isLoading ? (
              <Skeleton className="h-72 w-full" />
            ) : room && plan && property.data ? (
              <BookingSummaryCard
                propertyName={property.data.name}
                roomTypeName={room.roomTypeName}
                ratePlanName={plan.name}
                checkIn={checkIn}
                checkOut={checkOut}
                adults={adults}
                childCount={children}
                currency={property.data.currency}
                subtotal={plan.subtotal}
                extraGuestCharges={plan.extraGuestCharges}
                promoProblem={plan.promoProblem}
                discount={plan.discountAmount}
                tax={plan.taxAmount}
                total={plan.totalPrice}
                holdNote={reservation?.holdExpiresAt ? `Held until ${formatDate(reservation.holdExpiresAt, 'h:mm a')}${holdText ? ` (${holdText})` : ''}.` : undefined}
              />
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function BookingCheckoutPage() {
  return (
    <Suspense fallback={<div className="p-8"><Skeleton className="h-40 w-full" /></div>}>
      <Checkout />
    </Suspense>
  );
}
