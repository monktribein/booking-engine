'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Guest, ReservationStatus } from '@/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Drawer } from '@/components/ui/drawer';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { useDebounced } from '@/lib/hooks/use-debounced';
import { formatCurrency } from '@/lib/utils/currency';
import { errorMessage } from '@/lib/utils/errors';
import { formatDateShort } from '@/lib/utils/dates';
import { getStatusBadgeVariant } from '@/lib/utils/formatters';
import { guestsApi } from '@/lib/api/guests';
import { reservationsApi } from '@/lib/api/reservations';
import { Search, Plus, Phone, Mail, Eye, Shield } from 'lucide-react';

const PAGE_SIZE = 20;

export default function GuestsPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();

  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(searchQuery.trim());

  const query = useQuery({
    queryKey: ['guests', propertyId, q, page],
    queryFn: () => guestsApi.list({ propertyId: propertyId as string, search: q || undefined, page, limit: PAGE_SIZE }),
    enabled: !!propertyId,
    placeholderData: (prev) => prev,
  });

  const [selectedGuest, setSelectedGuest] = useState<Guest | null>(null);

  // The backend has no per-guest history endpoint: search reservations by the guest's first name and keep exact guest matches.
  const stays = useQuery({
    queryKey: ['guest-stays', propertyId, selectedGuest?._id],
    queryFn: async () => {
      const res = await reservationsApi.list({ propertyId: propertyId as string, search: selectedGuest!.firstName, limit: 100 });
      return res.items.filter((r) => r.guest._id === selectedGuest!._id);
    },
    enabled: !!propertyId && !!selectedGuest,
  });

  // New guest dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', notes: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const createMutation = useMutation({
    mutationFn: () =>
      guestsApi.create({
        propertyId: propertyId as string,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim() || undefined,
        phone: form.phone.replace(/[\s-]/g, '') || undefined, // E.164
        email: form.email.trim() || undefined,
        notes: form.notes.trim() || undefined,
      } as Partial<Guest> & { propertyId: string }),
    onSuccess: async () => {
      setCreateOpen(false);
      setForm({ firstName: '', lastName: '', phone: '', email: '', notes: '' });
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['guests', propertyId] });
    },
    onError: (e) => setFormError(errorMessage(e)), // form values are kept for correction
  });

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  const upcoming = (stays.data ?? []).filter((s) => s.status === ReservationStatus.CONFIRMED || s.status === ReservationStatus.CHECKED_IN || s.status === ReservationStatus.PENDING);
  const past = (stays.data ?? []).filter((s) => s.status === ReservationStatus.CHECKED_OUT);
  const bookedValue = (stays.data ?? []).filter((s) => s.status !== ReservationStatus.CANCELLED).reduce((a, s) => a + s.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Guest Directory</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Search guests, manage contact details and see their stays.</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative w-64 sm:w-80">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" aria-hidden="true" />
            <Input
              aria-label="Search guests"
              placeholder="Search by name, phone, email..."
              className="pl-9 text-xs h-9 rounded-xl border-stone-200 bg-white dark:bg-slate-900"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
            />
          </div>
          <Button size="sm" onClick={() => { setFormError(null); setCreateOpen(true); }} className="h-9 rounded-xl whitespace-nowrap">
            <Plus className="h-4 w-4 mr-1.5" /> Add Guest
          </Button>
        </div>
      </div>

      <Card className="rounded-3xl border border-stone-200/90 overflow-hidden bg-white dark:bg-slate-900">
        <CardContent className="p-0">
          <QueryState query={query} data={query.data} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No guests found" hint={q ? 'Try a different search.' : 'Guests appear here after their first booking, or add one manually.'} />}>
            {(data) => (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Guest Name</TableHead>
                      <TableHead>Contact Phone</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Country</TableHead>
                      <TableHead className="text-right">Profile</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((guest) => (
                      <TableRow key={guest._id}>
                        <TableCell className="font-semibold text-xs text-slate-900 dark:text-slate-100">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-50 text-indigo-700 text-xs font-bold" aria-hidden="true">{guest.firstName[0]}</div>
                            <span>{guest.firstName} {guest.lastName}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-slate-600 dark:text-slate-300">{guest.phone || '-'}</TableCell>
                        <TableCell className="text-xs text-slate-600 dark:text-slate-300">{guest.email || '-'}</TableCell>
                        <TableCell className="text-xs font-medium text-slate-500">{guest.country || '-'}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => setSelectedGuest(guest)} className="h-7 px-2 text-xs" aria-label={`View history of ${guest.firstName} ${guest.lastName}`}>
                            <Eye className="h-3.5 w-3.5 mr-1" /> View History
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500">
                  <span>{data.total} guest{data.total === 1 ? '' : 's'} • page {data.page} of {data.totalPages}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1 || query.isFetching} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button variant="outline" size="sm" disabled={page >= data.totalPages || query.isFetching} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              </>
            )}
          </QueryState>
        </CardContent>
      </Card>

      <Drawer
        isOpen={!!selectedGuest}
        onClose={() => setSelectedGuest(null)}
        title={selectedGuest ? `${selectedGuest.firstName} ${selectedGuest.lastName}` : 'Guest Profile'}
        description={`Guest profile • ${selectedGuest?.country || 'country not recorded'}`}
        width="lg"
      >
        {selectedGuest && (
          <div className="space-y-6">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Contact Information</h4>
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300"><Phone className="h-4 w-4 text-slate-400" /><span>{selectedGuest.phone || 'No phone recorded'}</span></div>
                <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300"><Mail className="h-4 w-4 text-slate-400" /><span>{selectedGuest.email || 'No email recorded'}</span></div>
                <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300"><Shield className="h-4 w-4 text-slate-400" /><span>ID documents are stored encrypted; only the last 4 characters are shown.</span></div>
              </div>
              {selectedGuest.notes && <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 italic">Note: &quot;{selectedGuest.notes}&quot;</div>}
            </div>

            <QueryState query={stays} data={stays.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No stays on record" />} skeletonRows={3}>
              {() => (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700">
                      <span className="text-xs text-slate-400 block">Booked value (non-cancelled)</span>
                      <span className="text-lg font-bold text-slate-900 dark:text-slate-100">{formatCurrency(bookedValue, stays.data?.[0]?.currency ?? 'INR')}</span>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700">
                      <span className="text-xs text-slate-400 block">Stays on record</span>
                      <span className="text-lg font-bold text-indigo-600 dark:text-indigo-400">{stays.data?.length ?? 0}</span>
                    </div>
                  </div>
                  <StayList title="Upcoming & current" stays={upcoming} />
                  <StayList title="Past stays" stays={past} />
                </>
              )}
            </QueryState>
          </div>
        )}
      </Drawer>

      <Dialog isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Register New Guest" description="Add a guest record to this property.">
        <form onSubmit={(e) => { e.preventDefault(); if (!createMutation.isPending) createMutation.mutate(); }} className="space-y-4">
          {formError && <Alert variant="danger" message={formError} />}
          <div className="grid grid-cols-2 gap-3">
            <Input label="First Name *" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            <Input label="Last Name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Phone (with country code)" placeholder="+919876543210" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input label="Email Address" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <Input label="Internal Notes" placeholder="e.g. Vegetarian preference" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={createMutation.isPending} disabled={createMutation.isPending}>Save Guest</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function StayList({ title, stays }: { title: string; stays: { _id: string; code: string; status: ReservationStatus; checkIn: string; checkOut: string; total: number; currency: string; rooms: { roomTypeName?: string }[] }[] }) {
  return (
    <div className="space-y-3">
      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">{title}</h4>
      {stays.length === 0 ? (
        <p className="text-xs text-slate-400 italic">None.</p>
      ) : (
        <div className="space-y-2">
          {stays.map((stay) => {
            const b = getStatusBadgeVariant(stay.status);
            return (
              <div key={stay._id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between">
                <div>
                  <div className="font-bold text-xs">{stay.code} - {stay.rooms[0]?.roomTypeName}</div>
                  <div className="text-[10px] text-slate-400">{formatDateShort(stay.checkIn)} - {formatDateShort(stay.checkOut)} • {formatCurrency(stay.total, stay.currency)}</div>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${b.bg} ${b.text} ${b.border}`}>{b.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
