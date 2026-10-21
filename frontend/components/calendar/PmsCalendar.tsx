'use client';

import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhysicalRoom, Reservation, RoomStatus } from '@/types';
import { formatDateShort, formatISODate } from '@/lib/utils/dates';
import { errorMessage } from '@/lib/utils/errors';
import { getChannelBadge } from '@/lib/utils/formatters';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Alert } from '../ui/alert';
import { EmptyState, ErrorState, NoPropertyState, QueryState } from '../ui/query-state';
import { ReservationDrawer } from '../reservations/ReservationDrawer';
import { addDays, isSameDay, startOfDay, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight, Wrench, Plus } from 'lucide-react';
import { inventoryApi } from '@/lib/api/inventory';
import { reservationsApi } from '@/lib/api/reservations';
import { roomTypesApi } from '@/lib/api/room-types';
import { roomsApi } from '@/lib/api/rooms';
import { useProperty } from '@/lib/auth/property-context';

const VIEW_DAYS = { day: 1, week: 7, month: 14 } as const;

export function PmsCalendar() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();

  const [viewMode, setViewMode] = useState<keyof typeof VIEW_DAYS>('week');
  const [baseDate, setBaseDate] = useState<Date>(() => startOfDay(new Date()));
  const [selectedRoomType, setSelectedRoomType] = useState<string>('all');
  const [selectedChannel, setSelectedChannel] = useState<string>('all');

  const dates = useMemo(() => Array.from({ length: VIEW_DAYS[viewMode] }, (_, i) => addDays(baseDate, i)), [baseDate, viewMode]);
  const from = formatISODate(dates[0]);
  const to = formatISODate(addDays(dates[dates.length - 1], 1));

  const roomsQuery = useQuery({
    queryKey: ['rooms', propertyId, 'calendar'],
    queryFn: async () => {
      const roomTypes = await roomTypesApi.list(propertyId as string);
      const rooms = (await Promise.all(roomTypes.map((rt) => roomsApi.listByRoomType(rt._id)))).flat();
      return { roomTypes, rooms };
    },
    enabled: !!propertyId,
  });
  const calendar = useQuery({
    queryKey: ['calendar', propertyId, from, to, 'tape'],
    queryFn: () => inventoryApi.getCalendar(propertyId as string, from, to),
    enabled: !!propertyId,
  });

  // Reservation detail drawer (the full reservation is fetched when a cell is opened)
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const openReservation = async (id: string) => {
    setOpenError(null);
    try {
      setSelectedReservation(await reservationsApi.get(id));
      setDrawerOpen(true);
    } catch (e) {
      setOpenError(errorMessage(e));
    }
  };

  // Block dialog
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockRoom, setBlockRoom] = useState<PhysicalRoom | null>(null);
  const [blockDate, setBlockDate] = useState('');
  const [blockReason, setBlockReason] = useState('MAINTENANCE');
  const [blockNotes, setBlockNotes] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['calendar', propertyId] });
  const blockMutation = useMutation({
    mutationFn: () =>
      inventoryApi.createBlock({
        propertyId: propertyId as string,
        roomTypeId: blockRoom!.roomTypeId,
        roomId: blockRoom!._id,
        startDate: blockDate,
        endDate: formatISODate(addDays(new Date(blockDate), 1)),
        reason: blockReason,
        notes: blockNotes.trim() || undefined,
      }),
    onSuccess: async () => {
      setBlockOpen(false);
      setBlockNotes('');
      setBlockError(null);
      await invalidate();
    },
    onError: (e) => setBlockError(errorMessage(e)),
  });
  const unblockMutation = useMutation({
    mutationFn: (id: string) => inventoryApi.unblock(id),
    onSuccess: invalidate,
    onError: (e) => setOpenError(errorMessage(e)),
  });

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  const roomsData = roomsQuery.data;
  const cal = calendar.data;
  const rooms = (roomsData?.rooms ?? []).filter((r) => selectedRoomType === 'all' || r.roomTypeId === selectedRoomType);

  const reservationFor = (room: PhysicalRoom, dateStr: string) =>
    cal?.reservations?.find(
      (res) =>
        (selectedChannel === 'all' || res.channel === selectedChannel) &&
        res.rooms.some((rm) => rm.roomId === room._id) &&
        dateStr >= res.checkIn &&
        dateStr < res.checkOut &&
        res.status !== 'CANCELLED'
    );
  const blockFor = (room: PhysicalRoom, dateStr: string) => cal?.blocks?.find((b) => b.roomId === room._id && b.status !== 'RELEASED' && dateStr >= b.startDate && dateStr < b.endDate);
  const unassigned = (cal?.reservations ?? []).filter((r) => r.status !== 'CANCELLED' && r.rooms.some((rm) => !rm.roomId) && (selectedChannel === 'all' || r.channel === selectedChannel));

  const today = new Date();

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1 text-xs font-semibold" role="tablist" aria-label="Calendar range">
            {(Object.keys(VIEW_DAYS) as (keyof typeof VIEW_DAYS)[]).map((mode) => (
              <button
                key={mode}
                role="tab"
                aria-selected={viewMode === mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-1 rounded-md capitalize transition-all cursor-pointer ${viewMode === mode ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-xs' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'}`}
              >
                {mode}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Previous" onClick={() => setBaseDate((d) => subDays(d, VIEW_DAYS[viewMode]))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs font-medium" onClick={() => setBaseDate(startOfDay(new Date()))}>
              Today
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Next" onClick={() => setBaseDate((d) => addDays(d, VIEW_DAYS[viewMode]))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <span className="text-xs font-bold text-slate-800 dark:text-slate-200 ml-2" aria-live="polite">
            {formatDateShort(dates[0])} - {formatDateShort(dates[dates.length - 1])}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <select aria-label="Room type" value={selectedRoomType} onChange={(e) => setSelectedRoomType(e.target.value)} className="h-8 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 text-xs">
            <option value="all">All Room Types</option>
            {(roomsData?.roomTypes ?? []).map((rt) => (
              <option key={rt._id} value={rt._id}>{rt.name}</option>
            ))}
          </select>
          <select aria-label="Channel" value={selectedChannel} onChange={(e) => setSelectedChannel(e.target.value)} className="h-8 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 text-xs">
            <option value="all">All Channels</option>
            <option value="AIRBNB">Airbnb</option>
            <option value="BOOKING_COM">Booking.com</option>
            <option value="AGODA">Agoda</option>
            <option value="DIRECT">Direct Website</option>
            <option value="TIRVONA">Tirvona</option>
            <option value="WALK_IN">Walk-In</option>
          </select>
        </div>
      </div>

      {openError && <Alert variant="danger" message={openError} onClose={() => setOpenError(null)} />}

      {roomsQuery.isError ? (
        <ErrorState error={roomsQuery.error} onRetry={() => void roomsQuery.refetch()} />
      ) : calendar.isError ? (
        <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} />
      ) : (
        <QueryState
          query={{ isLoading: roomsQuery.isLoading || calendar.isLoading, isError: false, error: null, refetch: () => undefined }}
          data={roomsData}
          isEmpty={(d) => d.rooms.length === 0}
          empty={<EmptyState title="No rooms yet" hint="Add physical rooms under Rooms to see them on the calendar." />}
          skeletonRows={6}
        >
          {() => (
            <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
                      <th scope="col" className="sticky left-0 z-20 w-44 bg-slate-50 dark:bg-slate-800/90 px-3 py-3 text-left font-bold text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-800">
                        Rooms ({rooms.length})
                      </th>
                      {dates.map((d) => (
                        <th key={d.toISOString()} scope="col" className={`min-w-[130px] px-2 py-2 text-center border-r border-slate-200/80 dark:border-slate-800 font-semibold ${isSameDay(d, today) ? 'bg-indigo-50/70 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 font-bold' : 'text-slate-600 dark:text-slate-400'}`}>
                          <div>{formatDateShort(d)}</div>
                          <div className="text-[10px] font-normal text-slate-500">{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {rooms.map((room) => {
                      const roomType = roomsData?.roomTypes.find((rt) => rt._id === room.roomTypeId);
                      return (
                        <tr key={room._id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                          <th scope="row" className="sticky left-0 z-10 w-44 bg-white dark:bg-slate-900 px-3 py-2.5 text-left font-medium border-r border-slate-200 dark:border-slate-800 shadow-xs">
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="font-bold text-slate-900 dark:text-slate-100">Room {room.roomNumber}</span>
                                <span className="text-[10px] text-slate-500 block truncate max-w-[95px]">{roomType?.name ?? ''}</span>
                              </div>
                              <span
                                title={room.status}
                                className={`h-2.5 w-2.5 rounded-full ${room.status === RoomStatus.OCCUPIED ? 'bg-blue-500' : room.status === RoomStatus.CLEANING ? 'bg-amber-500' : room.status === RoomStatus.MAINTENANCE ? 'bg-rose-500' : room.status === RoomStatus.BLOCKED ? 'bg-slate-400' : 'bg-emerald-500'}`}
                              />
                            </div>
                          </th>
                          {dates.map((date) => {
                            const dateStr = formatISODate(date);
                            const block = blockFor(room, dateStr);
                            const res = reservationFor(room, dateStr);

                            if (block) {
                              return (
                                <td key={dateStr} className="p-1 border-r border-slate-100 dark:border-slate-800 text-center align-middle">
                                  <button
                                    type="button"
                                    disabled={unblockMutation.isPending}
                                    onClick={() => {
                                      if (window.confirm(`Release this block on room ${room.roomNumber}?`)) unblockMutation.mutate(block._id);
                                    }}
                                    aria-label={`Release block on room ${room.roomNumber}, ${dateStr}`}
                                    className="w-full flex items-center justify-center gap-1 rounded-md bg-rose-50 dark:bg-rose-950/40 p-1.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 cursor-pointer"
                                  >
                                    <Wrench className="h-3 w-3 shrink-0" />
                                    <span className="truncate">{block.reason.replace(/_/g, ' ')}</span>
                                  </button>
                                </td>
                              );
                            }

                            if (res) {
                              const badge = getChannelBadge(res.channel);
                              return (
                                <td key={dateStr} className="p-1 border-r border-slate-100 dark:border-slate-800 align-middle">
                                  <button
                                    type="button"
                                    onClick={() => void openReservation(res.reservationId)}
                                    aria-label={`Reservation ${res.code} for ${res.guestName}`}
                                    className="w-full text-left rounded-lg p-2 shadow-xs transition-transform hover:scale-[1.02] border cursor-pointer"
                                    style={{ backgroundColor: `${badge.iconColor}15`, borderColor: `${badge.iconColor}40` }}
                                  >
                                    <div className="flex items-center justify-between gap-1 mb-0.5">
                                      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 rounded" style={{ backgroundColor: `${badge.iconColor}25`, color: badge.iconColor }}>
                                        {badge.label}
                                      </span>
                                      <span className="text-[10px] font-bold text-slate-800 dark:text-slate-100 truncate">{res.guestName.split(' ')[0]}</span>
                                    </div>
                                    <div className="text-[10px] text-slate-500 truncate">{res.code}</div>
                                  </button>
                                </td>
                              );
                            }

                            return (
                              <td key={dateStr} className="group p-1 border-r border-slate-100 dark:border-slate-800 align-middle text-center hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20 transition-colors">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBlockRoom(room);
                                    setBlockDate(dateStr);
                                    setBlockError(null);
                                    setBlockOpen(true);
                                  }}
                                  aria-label={`Block room ${room.roomNumber} on ${dateStr}`}
                                  className="h-9 w-full flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
                                >
                                  <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600 font-semibold bg-white dark:bg-slate-800 px-2 py-0.5 rounded shadow-xs border border-indigo-200">
                                    <Plus className="h-3 w-3" /> Block
                                  </span>
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </QueryState>
      )}

      {unassigned.length > 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-xs space-y-2">
          <div className="font-bold text-amber-800 dark:text-amber-300">Bookings without an assigned room in this range</div>
          <div className="flex flex-wrap gap-2">
            {unassigned.map((r) => (
              <button key={r.reservationId} type="button" onClick={() => void openReservation(r.reservationId)} className="rounded-lg border border-amber-300 bg-white dark:bg-slate-900 px-2.5 py-1 font-medium cursor-pointer">
                {r.code} • {r.guestName} • {formatDateShort(r.checkIn)}–{formatDateShort(r.checkOut)}
              </button>
            ))}
          </div>
        </div>
      )}

      <Dialog isOpen={blockOpen} onClose={() => setBlockOpen(false)} title={`Block Room ${blockRoom?.roomNumber || ''}`} description={`Take this room out of sale on ${blockDate}`} maxWidth="md">
        <form onSubmit={(e) => { e.preventDefault(); if (!blockMutation.isPending) blockMutation.mutate(); }} className="space-y-4">
          {blockError && <Alert variant="danger" message={blockError} />}
          <Select
            label="Block Reason *"
            value={blockReason}
            onChange={(e) => setBlockReason(e.target.value)}
            options={[
              { value: 'MAINTENANCE', label: 'Maintenance / Deep Cleaning' },
              { value: 'OWNER_BLOCK', label: 'Owner Hold / Private Use' },
              { value: 'MANUAL_BLOCK', label: 'Manual Staff Block' },
              { value: 'PRIVATE_EVENT', label: 'Event Hold' },
            ]}
          />
          <Input label="Internal Notes" placeholder="e.g. AC servicing scheduled" value={blockNotes} onChange={(e) => setBlockNotes(e.target.value)} />
          <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 border border-amber-200">
            This reduces sellable availability on the booking engine and every mapped channel until the block is released.
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setBlockOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" isLoading={blockMutation.isPending} disabled={blockMutation.isPending}>Block Room</Button>
          </div>
        </form>
      </Dialog>

      <ReservationDrawer reservation={selectedReservation} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
