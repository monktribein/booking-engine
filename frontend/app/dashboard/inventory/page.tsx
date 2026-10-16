'use client';

import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { inventoryApi } from '@/lib/api/inventory';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { EmptyState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { errorMessage } from '@/lib/utils/errors';
import { formatDateShort, formatISODate } from '@/lib/utils/dates';
import { addDays, parseISO, startOfDay, subDays } from 'date-fns';
import { Boxes, Ban, Unlock, ChevronLeft, ChevronRight, AlertTriangle, Sliders, CheckCircle } from 'lucide-react';

type Action = 'STOP_SELL' | 'UNBLOCK' | 'RESTRICTIONS';

export default function InventoryPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();

  const [baseDate, setBaseDate] = useState<Date>(() => startOfDay(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(baseDate, i)), [baseDate]);
  const from = formatISODate(days[0]);
  const to = formatISODate(addDays(days[6], 1));

  const query = useQuery({
    queryKey: ['calendar', propertyId, from, to],
    queryFn: () => inventoryApi.getCalendar(propertyId as string, from, to),
    enabled: !!propertyId,
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [action, setAction] = useState<Action>('STOP_SELL');
  const [targetDate, setTargetDate] = useState('');
  const [targetRoomTypeId, setTargetRoomTypeId] = useState('');
  const [minStay, setMinStay] = useState(1);
  const [maxStay, setMaxStay] = useState<number | ''>('');
  const [cta, setCta] = useState(false);
  const [ctd, setCtd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const range = { roomTypeId: targetRoomTypeId, from: targetDate, to: formatISODate(addDays(parseISO(targetDate), 1)) };
      if (action === 'STOP_SELL') return inventoryApi.setRestrictions(propertyId as string, { ...range, stopSell: true });
      if (action === 'UNBLOCK') return inventoryApi.setRestrictions(propertyId as string, { ...range, stopSell: false });
      return inventoryApi.setRestrictions(propertyId as string, {
        ...range,
        minimumStay: minStay,
        maximumStay: maxStay === '' ? undefined : Number(maxStay),
        closedToArrival: cta,
        closedToDeparture: ctd,
      });
    },
    onSuccess: async () => {
      setModalOpen(false);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['calendar', propertyId] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const openAction = (a: Action, dateStr: string, rtId: string) => {
    const cell = query.data?.roomTypes.find((r) => r.roomTypeId === rtId)?.days.find((d) => d.date === dateStr);
    setAction(a);
    setTargetDate(dateStr);
    setTargetRoomTypeId(rtId);
    setMinStay(cell?.minimumStay ?? 1);
    setMaxStay(cell?.maximumStay ?? '');
    setCta(cell?.closedToArrival ?? false);
    setCtd(cell?.closedToDeparture ?? false);
    setError(null);
    setModalOpen(true);
  };

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Date-Based Inventory & Restrictions</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            Control stop-sell signals, minimum stay, and closed-to-arrival/departure rules. Allotments follow your physical rooms.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => setBaseDate(subDays(baseDate, 7))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-slate-700 cursor-pointer transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-bold text-slate-800 bg-stone-100 px-3 py-1.5 rounded-xl border border-stone-200/60" aria-live="polite">
            {formatDateShort(days[0])} - {formatDateShort(days[6])}
          </span>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => setBaseDate(addDays(baseDate, 7))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-slate-700 cursor-pointer transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <QueryState
        query={query}
        data={query.data}
        isEmpty={(d) => d.roomTypes.length === 0}
        empty={<EmptyState title="No room types" hint="Create room types and rooms first; inventory is generated from them." />}
        skeletonRows={6}
      >
        {(cal) => (
          <div className="space-y-6">
            {cal.roomTypes.map((rt, index) => (
              <motion.div
                key={rt.roomTypeId}
                initial={{ opacity: 0, y: 36 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.15 }}
                transition={{
                  duration: 0.5,
                  delay: index * 0.12,
                  ease: 'easeOut',
                }}
              >
                <Card className="rounded-3xl border border-stone-200/90 overflow-hidden bg-white dark:bg-slate-900 transition-all hover:border-[#a8c6e5]">
                  <CardHeader className="bg-stone-50/60 dark:bg-slate-800/40 p-4 sm:p-5 border-b border-stone-100 dark:border-slate-800 flex flex-row items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-2xl bg-[#c1d8f0]/50 border border-[#a8c6e5]/60 flex items-center justify-center text-slate-900 shrink-0">
                        <Boxes className="h-5 w-5 text-slate-800" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-base font-bold text-slate-900 dark:text-slate-100">
                            {rt.roomTypeName}
                          </CardTitle>
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-[10px] font-semibold border border-emerald-200/60">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Live
                          </span>
                        </div>
                        <CardDescription className="text-xs text-slate-500 mt-0.5">
                          Total Allotment Capacity: <strong className="text-slate-800 dark:text-slate-200">{rt.days[0]?.total ?? 0} physical rooms</strong>
                        </CardDescription>
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center gap-2">
                      <span className="text-[11px] font-medium text-slate-500 bg-white dark:bg-slate-800 border border-stone-200/70 dark:border-slate-700 rounded-xl px-3 py-1">
                        7-Day Realtime Matrix
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="border-b border-stone-200/80 dark:border-slate-800 bg-stone-50/50 dark:bg-slate-800/20">
                            <th scope="col" className="p-3.5 text-left w-36 sm:w-44 font-bold text-slate-500 uppercase tracking-wider text-[11px] border-r border-stone-200/70 dark:border-slate-800">
                              Metric / Action
                            </th>
                            {days.map((d) => (
                              <th key={formatISODate(d)} scope="col" className="p-3 text-center min-w-[110px] border-r border-stone-200/70 dark:border-slate-800 font-bold text-slate-800 dark:text-slate-200">
                                <div>{formatDateShort(d)}</div>
                                <div className="text-[10px] font-normal text-slate-400">{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100 dark:divide-slate-800">
                          <tr className="bg-emerald-50/20 dark:bg-emerald-950/10">
                            <th scope="row" className="p-3.5 text-left font-bold text-emerald-900 dark:text-emerald-400 border-r border-stone-200/70 dark:border-slate-800 text-xs">
                              Sellable Available
                            </th>
                            {days.map((d) => {
                              const cell = rt.days.find((x) => x.date === formatISODate(d));
                              return (
                                <td key={formatISODate(d)} className="p-3 text-center border-r border-stone-200/70 dark:border-slate-800">
                                  {!cell ? (
                                    <span className="text-slate-300">—</span>
                                  ) : (
                                    <>
                                      {cell.stopSell ? (
                                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-50 dark:bg-rose-950/40 border border-rose-200/70 px-2 py-0.5 rounded-lg">
                                          <Ban className="h-3 w-3" /> Stop Sell
                                        </span>
                                      ) : (
                                        <span className="text-base font-black text-emerald-700 dark:text-emerald-400">{cell.available}</span>
                                      )}
                                      <div className="text-[10px] text-slate-400 font-medium mt-0.5">
                                        {cell.sold} sold • {cell.blocked} blk
                                      </div>
                                    </>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                          <tr>
                            <th scope="row" className="p-3.5 text-left font-semibold text-slate-600 dark:text-slate-400 border-r border-stone-200/70 dark:border-slate-800 text-xs">
                              Restrictions
                            </th>
                            {days.map((d) => {
                              const cell = rt.days.find((x) => x.date === formatISODate(d));
                              return (
                                <td key={formatISODate(d)} className="p-2.5 text-center border-r border-stone-200/70 dark:border-slate-800 text-[11px]">
                                  {cell && (
                                    <div className="space-y-1">
                                      <span className="inline-block text-[10px] font-semibold bg-stone-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-stone-200/60 dark:border-slate-700 px-2 py-0.5 rounded-md">
                                        Min: {cell.minimumStay}n
                                      </span>
                                      {cell.closedToArrival && <span className="block text-[10px] font-bold text-amber-800 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200/60 rounded-md px-1.5 py-0.5">CTA</span>}
                                      {cell.closedToDeparture && <span className="block text-[10px] font-bold text-amber-800 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200/60 rounded-md px-1.5 py-0.5">CTD</span>}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                          <tr className="bg-stone-50/40 dark:bg-slate-800/10">
                            <th scope="row" className="p-3.5 text-left font-semibold text-slate-500 border-r border-stone-200/70 dark:border-slate-800 text-xs">
                              Manage
                            </th>
                            {days.map((d) => {
                              const dateStr = formatISODate(d);
                              const cell = rt.days.find((x) => x.date === dateStr);
                              return (
                                <td key={dateStr} className="p-2.5 text-center border-r border-stone-200/70 dark:border-slate-800 align-middle">
                                  <div className="flex flex-col gap-1.5 items-center justify-center">
                                    {cell?.stopSell ? (
                                      <button
                                        type="button"
                                        onClick={() => openAction('UNBLOCK', dateStr, rt.roomTypeId)}
                                        className="inline-flex items-center gap-1 h-6 text-[10px] font-semibold px-2 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 cursor-pointer transition-colors"
                                        aria-label={`Re-open ${rt.roomTypeName} on ${dateStr}`}
                                      >
                                        <Unlock className="h-3 w-3 mr-0.5" /> Re-open
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => openAction('STOP_SELL', dateStr, rt.roomTypeId)}
                                        className="inline-flex items-center gap-1 h-6 text-[10px] font-semibold px-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 cursor-pointer transition-colors"
                                        aria-label={`Stop sell ${rt.roomTypeName} on ${dateStr}`}
                                      >
                                        <Ban className="h-3 w-3 mr-0.5" /> Stop Sell
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => openAction('RESTRICTIONS', dateStr, rt.roomTypeId)}
                                      className="inline-flex items-center gap-1 h-6 text-[10px] font-semibold px-2 rounded-lg bg-stone-100 hover:bg-stone-200/80 text-slate-700 border border-stone-200/80 cursor-pointer transition-colors"
                                      aria-label={`Edit rules for ${rt.roomTypeName} on ${dateStr}`}
                                    >
                                      <Sliders className="h-3 w-3 mr-0.5" /> Rules
                                    </button>
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        )}
      </QueryState>

      <Dialog
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={action === 'STOP_SELL' ? 'Confirm Stop Sell' : action === 'UNBLOCK' ? 'Re-Open Inventory' : 'Configure Stay Restrictions'}
        description={`Target date: ${targetDate}`}
        maxWidth="md"
      >
        <div className="space-y-4">
          {error && <Alert variant="danger" message={error} />}
          {action === 'STOP_SELL' && (
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 p-4 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 text-xs space-y-2">
              <div className="flex items-center gap-2 font-bold text-sm">
                <AlertTriangle className="h-5 w-5 text-rose-600" /> Confirm Stop Sell
              </div>
              <p>
                <strong>Stop Sell</strong> stops this room type from being sold on {targetDate}, on the direct booking engine and on every mapped channel. Existing reservations are not cancelled.
              </p>
            </div>
          )}
          {action === 'UNBLOCK' && (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 p-4 border border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300 text-xs space-y-2">
              <div className="flex items-center gap-2 font-bold text-sm">
                <CheckCircle className="h-5 w-5 text-emerald-600" /> Re-open inventory
              </div>
              <p>Sales resume for {targetDate}; remaining availability is synced to channels.</p>
            </div>
          )}
          {action === 'RESTRICTIONS' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Input label="Minimum Stay (Nights)" type="number" min={1} max={30} value={minStay} onChange={(e) => setMinStay(Number(e.target.value))} />
                <Input label="Maximum Stay (optional)" type="number" min={1} max={90} value={maxStay} onChange={(e) => setMaxStay(e.target.value === '' ? '' : Number(e.target.value))} />
              </div>
              <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <label className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer">
                  <input type="checkbox" checked={cta} onChange={(e) => setCta(e.target.checked)} className="rounded text-indigo-600" />
                  Closed to Arrival (CTA)
                </label>
                <label className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer">
                  <input type="checkbox" checked={ctd} onChange={(e) => setCtd(e.target.checked)} className="rounded text-indigo-600" />
                  Closed to Departure (CTD)
                </label>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={action === 'STOP_SELL' ? 'danger' : 'primary'}
              isLoading={mutation.isPending}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {action === 'STOP_SELL' ? 'Confirm Stop Sell' : action === 'UNBLOCK' ? 'Re-Open' : 'Save Restrictions'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
