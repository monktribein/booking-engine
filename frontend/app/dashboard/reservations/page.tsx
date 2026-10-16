'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, parseISO } from 'date-fns';
import { Reservation, ReservationStatus } from '@/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { ReservationDrawer } from '@/components/reservations/ReservationDrawer';
import { ReservationModal } from '@/components/reservations/ReservationModal';
import { CsvImportDialog } from '@/components/reservations/CsvImportDialog';
import { useProperty } from '@/lib/auth/property-context';
import { reservationsApi } from '@/lib/api/reservations';
import { channelsApi } from '@/lib/api/channels';
import { useDebounced } from '@/lib/hooks/use-debounced';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDateShort, formatISODate } from '@/lib/utils/dates';
import { getChannelBadge, getStatusBadgeVariant } from '@/lib/utils/formatters';
import { Search, Plus, Eye, Upload } from 'lucide-react';

const PAGE_SIZE = 20;

const TABS = [
  { id: 'ALL', label: 'All Bookings' },
  { id: ReservationStatus.CONFIRMED, label: 'Confirmed' },
  { id: ReservationStatus.CHECKED_IN, label: 'Checked In' },
  { id: ReservationStatus.PENDING, label: 'Pending' },
  { id: ReservationStatus.CHECKED_OUT, label: 'Checked Out' },
  { id: ReservationStatus.CANCELLED, label: 'Cancelled' },
  { id: ReservationStatus.NO_SHOW, label: 'No Show' },
];

export default function ReservationsPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;

  const [activeTab, setActiveTab] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedChannel, setSelectedChannel] = useState<string>('ALL');
  const [stayDate, setStayDate] = useState<string>('');
  const [page, setPage] = useState(1);

  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const q = useDebounced(searchQuery.trim());

  // All filtering is done by the backend; the table only shows what the server returned.
  const query = useQuery({
    queryKey: ['reservations', propertyId, activeTab, selectedChannel, stayDate, q, page],
    queryFn: () =>
      reservationsApi.list({
        propertyId: propertyId as string,
        status: activeTab === 'ALL' ? undefined : (activeTab as ReservationStatus),
        channel: selectedChannel === 'ALL' ? undefined : selectedChannel,
        from: stayDate || undefined,
        to: stayDate ? formatISODate(addDays(parseISO(stayDate), 1)) : undefined,
        search: q || undefined,
        page,
        limit: PAGE_SIZE,
      }),
    enabled: !!propertyId,
    placeholderData: (prev) => prev,
  });

  const channelList = useQuery({ queryKey: ['channels', propertyId], queryFn: () => channelsApi.list(propertyId as string), enabled: !!propertyId });

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };

  const handleOpenDetail = (res: Reservation) => {
    setSelectedReservation(res);
    setDrawerOpen(true);
  };

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Reservations Management</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            Search, filter, check-in guests, assign physical rooms, and manage lifecycle events.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4 mr-1.5" /> Import CSV
          </Button>
          <Button size="sm" onClick={() => setCreateModalOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> New Reservation
          </Button>
        </div>
      </div>

      <Tabs items={TABS} activeId={activeTab} onChange={resetPage(setActiveTab)} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200/80 dark:border-slate-800 shadow-2xs">
        <div className="relative">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" aria-hidden="true" />
          <Input
            aria-label="Search reservations"
            placeholder="Search code or guest name..."
            className="pl-9 text-xs h-9"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <select
          aria-label="Filter by channel"
          value={selectedChannel}
          onChange={(e) => resetPage(setSelectedChannel)(e.target.value)}
          className="h-9 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 text-xs text-slate-700 dark:text-slate-200"
        >
          <option value="ALL">All Channels</option>
          <option value="DIRECT">Direct Website</option>
          <option value="AIRBNB">Airbnb</option>
          <option value="BOOKING_COM">Booking.com</option>
          <option value="AGODA">Agoda</option>
          <option value="TIRVONA">Tirvona</option>
          <option value="WALK_IN">Walk-in</option>
          <option value="PHONE">Phone</option>
          <option value="AGENT">Agent</option>
          <option value="ICAL">iCal calendars</option>
          <option value="CSV_IMPORT">CSV import</option>
          {(channelList.data ?? []).filter((c) => c.configured && c.channel !== 'ICAL').map((c) => (
            <option key={c.channel} value={c.channel}>{c.name}</option>
          ))}
        </select>

        <Input
          aria-label="Stays on date"
          type="date"
          className="h-9 text-xs"
          value={stayDate}
          onChange={(e) => resetPage(setStayDate)(e.target.value)}
        />
      </div>

      <Card className="shadow-xs overflow-hidden">
        <CardContent className="p-0">
          <QueryState
            query={query}
            data={query.data}
            isEmpty={(d) => d.items.length === 0}
            empty={<EmptyState title="No reservations found" hint="Nothing matches the selected filters." />}
          >
            {(data) => (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Booking Code</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Guest</TableHead>
                      <TableHead>Room Type & Room</TableHead>
                      <TableHead>Dates</TableHead>
                      <TableHead>Occupancy</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((res) => {
                      const chBadge = getChannelBadge(res.source);
                      const stBadge = getStatusBadgeVariant(res.status);
                      const primaryRoom = res.rooms[0];
                      return (
                        <TableRow key={res._id}>
                          <TableCell className="font-bold text-xs text-slate-900 dark:text-slate-100">{res.code}</TableCell>
                          <TableCell>
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${chBadge.bg} ${chBadge.text}`}>{chBadge.label}</span>
                          </TableCell>
                          <TableCell>
                            <div className="font-semibold text-xs text-slate-900 dark:text-slate-100">
                              {res.guest.firstName} {res.guest.lastName}
                            </div>
                            <div className="text-[10px] text-slate-400">{res.guest.phone || res.guest.email}</div>
                          </TableCell>
                          <TableCell>
                            <div className="text-xs font-medium text-slate-800 dark:text-slate-200">{primaryRoom?.roomTypeName ?? '-'}</div>
                            <div className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400">
                              {primaryRoom?.roomNumber ? `Room ${primaryRoom.roomNumber}` : 'Pending Assignment'}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatDateShort(res.checkIn)} - {formatDateShort(res.checkOut)}
                          </TableCell>
                          <TableCell className="text-xs text-slate-500">
                            {res.adults} Adults {res.children ? `• ${res.children} Ch` : ''}
                          </TableCell>
                          <TableCell>
                            <span className={`inline-flex px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${stBadge.bg} ${stBadge.text} ${stBadge.border}`}>
                              {stBadge.label}
                            </span>
                          </TableCell>
                          <TableCell className="font-bold text-xs text-slate-900 dark:text-slate-100">{formatCurrency(res.total, res.currency)}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => handleOpenDetail(res)} className="h-7 px-2 text-xs" aria-label={`View reservation ${res.code}`}>
                              <Eye className="h-3.5 w-3.5 mr-1" /> View / Edit
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500">
                  <span>
                    {data.total} reservation{data.total === 1 ? '' : 's'} • page {data.page} of {data.totalPages}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1 || query.isFetching} onClick={() => setPage((p) => p - 1)}>
                      Previous
                    </Button>
                    <Button variant="outline" size="sm" disabled={page >= data.totalPages || query.isFetching} onClick={() => setPage((p) => p + 1)}>
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </QueryState>
        </CardContent>
      </Card>

      <ReservationDrawer reservation={selectedReservation} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <ReservationModal isOpen={createModalOpen} onClose={() => setCreateModalOpen(false)} />
      <CsvImportDialog propertyId={propertyId} currency={activeProperty?.currency ?? "INR"} isOpen={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
