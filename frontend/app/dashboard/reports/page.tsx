'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { EmptyState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { reportsApi } from '@/lib/api/reports';
import { formatCurrency } from '@/lib/utils/currency';
import { getChannelBadge } from '@/lib/utils/formatters';
import { TrendingUp, PieChart } from 'lucide-react';

const PERIODS = { '7d': 7, '30d': 30, '90d': 90 } as const;
type Period = keyof typeof PERIODS;

export default function ReportsPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const currency = activeProperty?.currency ?? 'INR';
  const [period, setPeriod] = useState<Period>('30d');

  // Trailing window: stays arriving in [today - N, today + 1)
  const today = new Date();
  const from = format(addDays(today, -PERIODS[period]), 'yyyy-MM-dd');
  const to = format(addDays(today, 1), 'yyyy-MM-dd');

  const revenue = useQuery({
    queryKey: ['reports', 'revenue', propertyId, from, to],
    queryFn: () => reportsApi.getRevenueReport(propertyId as string, from, to),
    enabled: !!propertyId,
  });
  const occupancy = useQuery({
    queryKey: ['reports', 'occupancy', propertyId, from, to],
    queryFn: () => reportsApi.getOccupancyReport(propertyId as string, from, to),
    enabled: !!propertyId,
  });

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Analytics & Reports</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Room revenue, ADR, RevPAR, channel mix and nightly occupancy for the last {PERIODS[period]} days.</p>
        </div>
        <div className="inline-flex rounded-xl bg-stone-100 dark:bg-slate-800 p-1 text-xs font-semibold" role="tablist" aria-label="Report period">
          {(Object.keys(PERIODS) as Period[]).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={period === p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded-lg uppercase transition-all cursor-pointer ${period === p ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 font-bold border border-stone-200/60' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <QueryState query={revenue} data={revenue.data} skeletonRows={2}>
        {(r) => (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card className="p-4 rounded-3xl border border-stone-200/90 bg-white dark:bg-slate-900">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Room Revenue</span>
                <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">{formatCurrency(r.totalRevenue, r.currency ?? currency)}</div>
                <span className="text-[11px] text-slate-400">Net of discounts, excluding tax</span>
              </Card>
              <Card className="p-4 rounded-3xl border border-stone-200/90 bg-white dark:bg-slate-900">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">ADR</span>
                <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">{formatCurrency(r.adr, r.currency ?? currency)}</div>
                <span className="text-[11px] text-slate-400">Per sold room night</span>
              </Card>
              <Card className="p-4 rounded-3xl border border-stone-200/90 bg-white dark:bg-slate-900">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">RevPAR</span>
                <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">{formatCurrency(r.revPar, r.currency ?? currency)}</div>
                <span className="text-[11px] text-slate-400">Per available room night</span>
              </Card>
              <Card className="p-4 rounded-3xl border border-stone-200/90 bg-white dark:bg-slate-900">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Average Occupancy</span>
                <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                  {occupancy.data && occupancy.data.length > 0 ? `${(occupancy.data.reduce((a, d) => a + d.occupancyPercent, 0) / occupancy.data.length).toFixed(1)}%` : occupancy.isError ? 'n/a' : '…'}
                </div>
                <span className="text-[11px] text-slate-400">Mean of nightly occupancy</span>
              </Card>
            </div>

            <Card className="rounded-3xl border border-stone-200/90 overflow-hidden bg-white dark:bg-slate-900">
              <CardHeader className="p-4 sm:p-5 border-b border-stone-100 dark:border-slate-800">
                <CardTitle className="text-base font-bold flex items-center gap-2">
                  <PieChart className="h-4 w-4 text-emerald-600" /> Channel Performance Share
                </CardTitle>
                <CardDescription>Revenue contribution by booking source</CardDescription>
              </CardHeader>
              <CardContent className="p-4 sm:p-5 space-y-4">
                {r.bySource.length === 0 ? (
                  <EmptyState title="No bookings in this period" />
                ) : (
                  <>
                    <div className="h-3 w-full rounded-full overflow-hidden flex bg-stone-100" role="img" aria-label="Revenue share by channel">
                      {r.bySource.map((s) => (
                        <div key={s.source} style={{ width: `${s.percentage}%`, backgroundColor: getChannelBadge(s.source).iconColor }} title={`${getChannelBadge(s.source).label}: ${s.percentage}%`} />
                      ))}
                    </div>
                    <div className="divide-y divide-stone-100 dark:divide-slate-800 text-xs">
                      {r.bySource.map((s) => {
                        const b = getChannelBadge(s.source);
                        return (
                          <div key={s.source} className="flex items-center justify-between py-2.5">
                            <div className="flex items-center gap-2">
                              <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: b.iconColor }} />
                              <span className="font-semibold text-slate-800 dark:text-slate-200">{b.label}</span>
                              <span className="text-slate-400">{s.bookings} booking{s.bookings === 1 ? '' : 's'}</span>
                            </div>
                            <div className="text-right">
                              <span className="font-bold text-slate-900 dark:text-slate-100">{formatCurrency(s.revenue, r.currency ?? currency)}</span>
                              <span className="text-[10px] text-slate-400 ml-2">({s.percentage}%)</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </QueryState>

      <Card className="rounded-3xl border border-stone-200/90 overflow-hidden bg-white dark:bg-slate-900">
        <CardHeader className="p-4 sm:p-5 border-b border-stone-100 dark:border-slate-800">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-slate-700" /> Nightly Occupancy
          </CardTitle>
          <CardDescription>Sold rooms as a share of sellable rooms, per night</CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-5 pt-3">
          <QueryState query={occupancy} data={occupancy.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No inventory for this period" />} skeletonRows={3}>
            {(rows) => (
              <div className="h-56 w-full flex items-end gap-0.5 pt-6 pb-2 px-1 border-b border-stone-100 dark:border-slate-800 overflow-x-auto" role="img" aria-label="Nightly occupancy chart">
                {rows.map((d) => (
                  <div key={d.date} className="flex-1 min-w-[6px] flex flex-col items-center justify-end h-full group relative">
                    <div className="opacity-0 group-hover:opacity-100 absolute -top-9 z-20 bg-slate-900 text-white text-[10px] font-bold rounded-md px-2 py-1 pointer-events-none whitespace-nowrap">
                      {d.date}: {d.occupancyPercent}% ({d.soldRooms}/{d.totalRooms - d.blockedRooms})
                    </div>
                    <div style={{ height: `${Math.max(2, d.occupancyPercent)}%` }} className="w-full bg-[#c1d8f0] hover:bg-[#acc8e6] rounded-t-sm transition-colors" />
                  </div>
                ))}
              </div>
            )}
          </QueryState>
        </CardContent>
      </Card>
    </div>
  );
}
