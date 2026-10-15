'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useProperty } from '@/lib/auth/property-context';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ReservationDrawer } from '@/components/reservations/ReservationDrawer';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDateShort, formatDate } from '@/lib/utils/dates';
import { getChannelBadge, getStatusBadgeVariant } from '@/lib/utils/formatters';
import { reportsApi } from '@/lib/api/reports';
import { reservationsApi } from '@/lib/api/reservations';
import { channelsApi } from '@/lib/api/channels';
import { Reservation } from '@/types';
import { BedDouble, DoorOpen, CalendarCheck, TrendingUp, ArrowRight, Radio, ExternalLink, ShieldCheck, AlertTriangle, Eye } from 'lucide-react';

export default function DashboardHomePage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const currency = activeProperty?.currency ?? 'INR';
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const stats = useQuery({
    queryKey: ['dashboard', 'stats', propertyId],
    queryFn: () => reportsApi.getDashboardStats(propertyId as string, currency),
    enabled: !!propertyId,
  });
  const recent = useQuery({
    queryKey: ['reservations', propertyId, 'recent'],
    queryFn: () => reservationsApi.list({ propertyId: propertyId as string, limit: 5 }),
    enabled: !!propertyId,
  });
  const channels = useQuery({
    queryKey: ['channels', propertyId],
    queryFn: () => channelsApi.list(propertyId as string),
    enabled: !!propertyId,
  });

  if (!propertyId) {
    return propertyLoading ? <Skeleton className="h-40 w-full" /> : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 p-6 text-white shadow-xl">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-indigo-200">
            <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true"></span>
            Property Management System
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">{activeProperty.name}</h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-xl">
            {activeProperty.city}, {activeProperty.state}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/stays/${activeProperty.slug}`} target="_blank">
            <Button variant="secondary" size="sm" className="font-semibold shadow-xs">
              <ExternalLink className="h-4 w-4 mr-1.5" /> View Public Engine
            </Button>
          </Link>
          <Link href="/dashboard/calendar">
            <Button size="sm" className="font-semibold bg-indigo-500 hover:bg-indigo-600 shadow-md">
              PMS Calendar <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          </Link>
        </div>
      </div>

      {stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.isLoading || !stats.data ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)
          ) : (
            <>
              <StatCard title="Total Rooms" value={stats.data.totalRooms} subtitle={`${stats.data.occupiedRooms} sold tonight • ${stats.data.availableRooms} available`} icon={<BedDouble className="h-5 w-5 text-indigo-600" />} />
              <StatCard title="Occupancy Tonight" value={`${stats.data.occupancyPercent}%`} subtitle="Sold of sellable rooms" icon={<TrendingUp className="h-5 w-5 text-emerald-600" />} />
              <StatCard title="Today's Arrivals" value={stats.data.todayCheckIns} subtitle={`${stats.data.todayCheckOuts} departures`} icon={<CalendarCheck className="h-5 w-5 text-blue-600" />} />
              <StatCard title="Arrivals Revenue" value={formatCurrency(stats.data.todayRevenue, stats.data.currency)} subtitle="Room revenue of stays arriving today" highlight icon={<DoorOpen className="h-5 w-5 text-amber-600" />} />
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Radio className="h-4 w-4 text-indigo-600" /> Channel Manager
              </CardTitle>
              <CardDescription>Connection status</CardDescription>
            </div>
            <Link href="/dashboard/channels" className="text-xs font-semibold text-indigo-600 hover:underline">Manage</Link>
          </CardHeader>
          <CardContent className="space-y-3 pt-1">
            <QueryState query={channels} data={channels.data} isEmpty={(d) => d.length === 0} skeletonRows={3}>
              {(list) =>
                list.map((ch) => {
                  const badge = getChannelBadge(ch.channel);
                  const state = ch.internal ? 'ok' : !ch.available ? 'unavailable' : ch.status === 'CONNECTED' ? (ch.lastError ? 'error' : 'ok') : 'off';
                  return (
                    <div key={ch.channel} className="flex items-center justify-between p-2.5 rounded-xl border border-slate-100 dark:border-slate-800/80 bg-slate-50/60 dark:bg-slate-800/30">
                      <div className="flex items-center gap-2.5">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: badge.iconColor }} aria-hidden="true" />
                        <div>
                          <div className="text-xs font-bold text-slate-800 dark:text-slate-200">{ch.name}</div>
                          <div className="text-[10px] text-slate-400">{ch.internal ? 'Built in' : ch.lastSyncAt ? `Last sync: ${formatDate(ch.lastSyncAt, 'd MMM, h:mm a')}` : 'Never synced'}</div>
                        </div>
                      </div>
                      {state === 'ok' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700">
                          <ShieldCheck className="h-3 w-3" /> Active
                        </span>
                      )}
                      {state === 'error' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700">
                          <AlertTriangle className="h-3 w-3" /> Error
                        </span>
                      )}
                      {state === 'unavailable' && <span className="text-[10px] font-medium text-amber-600">Partner access needed</span>}
                      {state === 'off' && <span className="text-[10px] font-medium text-slate-400">Not connected</span>}
                    </div>
                  );
                })
              }
            </QueryState>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-sm font-bold">Recent Reservations</CardTitle>
              <CardDescription>Latest stays across channels and the direct engine</CardDescription>
            </div>
            <Link href="/dashboard/reservations" className="text-xs font-semibold text-indigo-600 hover:underline">
              View All{recent.data ? ` (${recent.data.total})` : ''}
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            <QueryState query={recent} data={recent.data} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No reservations yet" />} skeletonRows={4}>
              {(data) => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Booking</TableHead>
                      <TableHead>Guest</TableHead>
                      <TableHead>Room</TableHead>
                      <TableHead>Dates</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((res) => {
                      const chBadge = getChannelBadge(res.source);
                      const stBadge = getStatusBadgeVariant(res.status);
                      return (
                        <TableRow key={res._id}>
                          <TableCell>
                            <div className="font-semibold text-xs text-slate-900 dark:text-slate-100">{res.code}</div>
                            <span className={`inline-block px-1.5 rounded text-[10px] font-medium ${chBadge.bg} ${chBadge.text}`}>{chBadge.label}</span>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-xs">{res.guest.firstName} {res.guest.lastName}</div>
                            <div className="text-[10px] text-slate-400">{res.guest.phone || res.guest.email}</div>
                          </TableCell>
                          <TableCell>
                            <div className="text-xs font-medium">{res.rooms[0]?.roomTypeName ?? '-'}</div>
                            <div className="text-[10px] text-indigo-600">{res.rooms[0]?.roomNumber ? `Room ${res.rooms[0].roomNumber}` : 'Unassigned'}</div>
                          </TableCell>
                          <TableCell className="text-xs">{formatDateShort(res.checkIn)} - {formatDateShort(res.checkOut)}</TableCell>
                          <TableCell>
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${stBadge.bg} ${stBadge.text} ${stBadge.border}`}>{stBadge.label}</span>
                          </TableCell>
                          <TableCell className="font-semibold text-xs">{formatCurrency(res.total, res.currency)}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => { setSelectedReservation(res); setDrawerOpen(true); }} className="h-7 px-2 text-xs" aria-label={`View reservation ${res.code}`}>
                              <Eye className="h-3.5 w-3.5 mr-1" /> View
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </QueryState>
          </CardContent>
        </Card>
      </div>

      <ReservationDrawer reservation={selectedReservation} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
