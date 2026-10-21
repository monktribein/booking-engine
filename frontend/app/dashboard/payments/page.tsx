'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Payment, PaymentStatus, Reservation, ReservationPaymentStatus, ReservationStatus } from '@/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog } from '@/components/ui/dialog';
import { Drawer } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Alert } from '@/components/ui/alert';
import { EmptyState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { formatCurrency } from '@/lib/utils/currency';
import { errorMessage } from '@/lib/utils/errors';
import { formatDate } from '@/lib/utils/dates';
import { getPaymentStatusBadge } from '@/lib/utils/formatters';
import { PaymentVisibilityPanel } from '@/components/payments/PaymentVisibilityPanel';
import { describePayment, toneClass } from '@/lib/utils/payment-visibility';
import { paymentsApi } from '@/lib/api/payments';
import { reservationsApi } from '@/lib/api/reservations';
import { CreditCard, Plus, RotateCcw } from 'lucide-react';

const PAGE_SIZE = 20;
const balanceDue = (r: Reservation) => Math.max(0, r.total - ((r.amountPaid ?? 0) - (r.amountRefunded ?? 0)));

export default function PaymentsPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Reservation | null>(null);

  // The backend lists payments per reservation, so this page lists reservations with their payment totals.
  const reservations = useQuery({
    queryKey: ['reservations', propertyId, 'payments-page', page],
    queryFn: () => reservationsApi.list({ propertyId: propertyId as string, page, limit: PAGE_SIZE }),
    enabled: !!propertyId,
    placeholderData: (prev) => prev,
  });

  const payments = useQuery({
    queryKey: ['payments', selected?._id],
    queryFn: () => paymentsApi.listForReservation(selected!._id),
    enabled: !!selected,
  });

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Record offline payment
  const [recordOpen, setRecordOpen] = useState(false);
  const [amountMajor, setAmountMajor] = useState<number | ''>('');
  const [provider, setProvider] = useState<string>('CASH');
  const [reference, setReference] = useState('');
  const recordMutation = useMutation({
    mutationFn: () =>
      paymentsApi.recordPayment({
        reservationId: selected!._id,
        provider,
        amount: amountMajor === '' ? undefined : Math.round(Number(amountMajor) * 100), // blank = full balance due
        reference: reference.trim() || undefined,
      }),
    onSuccess: async () => {
      setRecordOpen(false);
      setError(null);
      setNotice('Payment recorded.');
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['payments'] }), queryClient.invalidateQueries({ queryKey: ['reservations'] })]);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  // Refund
  const [refundTarget, setRefundTarget] = useState<Payment | null>(null);
  const [refundAmountMajor, setRefundAmountMajor] = useState<number | ''>('');
  const [refundReason, setRefundReason] = useState('');
  const refundMutation = useMutation({
    mutationFn: () =>
      paymentsApi.refund(refundTarget!._id, {
        amount: refundAmountMajor === '' ? undefined : Math.round(Number(refundAmountMajor) * 100), // blank = everything refundable
        reason: refundReason.trim(),
      }),
    onSuccess: async () => {
      setRefundTarget(null);
      setError(null);
      setNotice('Refund requested. It is executed at the gateway by the payment worker.');
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['payments'] }), queryClient.invalidateQueries({ queryKey: ['reservations'] })]);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Payments & Transactions</h1>
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
          Open a reservation to see its Razorpay and offline payments, record a desk payment, or request a refund.
        </p>
      </div>

      {notice && <Alert variant="success" message={notice} onClose={() => setNotice(null)} />}

      <Card className="shadow-xs overflow-hidden">
        <CardContent className="p-0">
          <QueryState query={reservations} data={reservations.data} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No reservations yet" />}>
            {(data) => (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reservation</TableHead>
                      <TableHead>Guest</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Paid</TableHead>
                      <TableHead>Balance due</TableHead>
                      <TableHead>Payment status</TableHead>
                      <TableHead className="text-right">Payments</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((r) => (
                      <TableRow key={r._id}>
                        <TableCell className="font-bold text-xs">{r.code}</TableCell>
                        <TableCell className="text-xs">{r.guest.firstName} {r.guest.lastName}</TableCell>
                        <TableCell className="text-xs font-semibold">{formatCurrency(r.total, r.currency)}</TableCell>
                        <TableCell className="text-xs">{formatCurrency(r.amountPaid ?? 0, r.currency)}</TableCell>
                        <TableCell className="text-xs">{r.status === ReservationStatus.CANCELLED ? '-' : describePayment(r).balanceDue.known ? formatCurrency(balanceDue(r), r.currency) : <span data-unavailable="true" className="text-slate-500">Unavailable</span>}</TableCell>
                        <TableCell className="text-[11px] font-medium">
                          <span className={toneClass(describePayment(r).summary.tone)} data-unavailable={describePayment(r).summary.label === 'Unavailable' ? 'true' : undefined}>{describePayment(r).summary.label}</span>
                          {describePayment(r).isChannel && <span className="block text-[10px] font-normal text-slate-500">Channel booking</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-label={`Payments for ${r.code}`} onClick={() => { setError(null); setNotice(null); setSelected(r); }}>
                            <CreditCard className="h-3.5 w-3.5 mr-1" /> Open
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500">
                  <span>page {data.page} of {data.totalPages}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1 || reservations.isFetching} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button variant="outline" size="sm" disabled={page >= data.totalPages || reservations.isFetching} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              </>
            )}
          </QueryState>
        </CardContent>
      </Card>

      <Drawer isOpen={!!selected} onClose={() => setSelected(null)} title={selected ? `Payments • ${selected.code}` : 'Payments'} description={selected ? (describePayment(selected).balanceDue.known ? `Balance due ${formatCurrency(balanceDue(selected), selected.currency)}` : 'Balance due unavailable') : ''} width="lg">
        {selected && (
          <div className="space-y-4">
            {error && !recordOpen && !refundTarget && <Alert variant="danger" message={error} onClose={() => setError(null)} />}
            <PaymentVisibilityPanel reservation={selected} />
            <Button size="sm" disabled={selected.status === ReservationStatus.CANCELLED || balanceDue(selected) === 0 || selected.paymentStatus === ReservationPaymentStatus.CHANNEL_COLLECTED} onClick={() => { setError(null); setAmountMajor(''); setReference(''); setRecordOpen(true); }}>
              <Plus className="h-4 w-4 mr-1.5" /> Record Payment
            </Button>
            <QueryState query={payments} data={payments.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No payments on this reservation" />} skeletonRows={2}>
              {(list) => (
                <div className="space-y-2">
                  {list.map((p) => {
                    const badge = getPaymentStatusBadge(p.status);
                    const refundable = p.amount - (p.amountRefunded ?? 0);
                    return (
                      <div key={p._id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-extrabold">{formatCurrency(p.amount, p.currency)}</span>
                          <span className={`inline-flex px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${badge.bg}`}>{badge.label}</span>
                        </div>
                        <div className="text-slate-500 flex items-center justify-between">
                          <span>{p.provider}{p.paidAt ? ` • ${formatDate(p.paidAt, 'd MMM yyyy, h:mm a')}` : ''}</span>
                          {p.status === PaymentStatus.PAID && refundable > 0 && (
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-rose-600" onClick={() => { setError(null); setRefundAmountMajor(''); setRefundReason(''); setRefundTarget(p); }}>
                              <RotateCcw className="h-3 w-3 mr-1" /> Refund
                            </Button>
                          )}
                        </div>
                        {(p.amountRefunded ?? 0) > 0 && <div className="text-rose-600">Refunded {formatCurrency(p.amountRefunded ?? 0, p.currency)}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </QueryState>
          </div>
        )}
      </Drawer>

      <Dialog isOpen={recordOpen} onClose={() => setRecordOpen(false)} title="Record Payment" description="Cash or bank transfer received at the desk. Online payments are taken by the guest through Razorpay Checkout.">
        <form onSubmit={(e) => { e.preventDefault(); if (!recordMutation.isPending) recordMutation.mutate(); }} className="space-y-4">
          {error && <Alert variant="danger" message={error} />}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Amount (₹)" type="number" min={1} step="0.01" placeholder="Full balance" value={amountMajor} onChange={(e) => setAmountMajor(e.target.value === '' ? '' : Number(e.target.value))} helperText="Leave blank for the full balance due" />
            <Select label="Payment Method *" value={provider} onChange={(e) => setProvider(e.target.value)} options={[{ value: 'CASH', label: 'Cash at Front Desk' }, { value: 'BANK_TRANSFER', label: 'Bank transfer' }, { value: 'OTHER', label: 'Other' }]} />
          </div>
          <Input label="Receipt / reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setRecordOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={recordMutation.isPending} disabled={recordMutation.isPending}>Confirm Payment</Button>
          </div>
        </form>
      </Dialog>

      <Dialog isOpen={!!refundTarget} onClose={() => setRefundTarget(null)} title="Request Refund" description="Queued and executed at the gateway. This cannot be undone.">
        <form onSubmit={(e) => { e.preventDefault(); if (!refundMutation.isPending) refundMutation.mutate(); }} className="space-y-4">
          {error && <Alert variant="danger" message={error} />}
          <Input label="Refund Amount (₹)" type="number" min={1} step="0.01" placeholder="Everything refundable" value={refundAmountMajor} onChange={(e) => setRefundAmountMajor(e.target.value === '' ? '' : Number(e.target.value))} helperText="Leave blank for a full refund" />
          <Input label="Reason *" required maxLength={500} value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setRefundTarget(null)}>Cancel</Button>
            <Button type="submit" variant="danger" isLoading={refundMutation.isPending} disabled={refundMutation.isPending || !refundReason.trim()}>Request Refund</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
