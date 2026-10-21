'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, parseISO } from 'date-fns';
import { CalendarRange } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { EmptyState, QueryState } from '@/components/ui/query-state';
import { ratesApi } from '@/lib/api/rates';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDate, todayInTimeZone } from '@/lib/utils/dates';
import { errorMessage } from '@/lib/utils/errors';
import type { RatePlan, RateRule } from '@/types';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon, Tue" / "Every day" / "Weekends" for a rule's weekday filter. */
export function describeDays(days?: number[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return 'Every day';
  const key = [...days].sort().join(',');
  if (key === '0,6') return 'Weekends (Sat, Sun)';
  if (key === '5,6') return 'Fri, Sat';
  return [...days].sort().map((d) => WEEKDAYS[d]).join(', ');
}

/** One-line description of what a rule does to the price. */
export function describeAdjustment(rule: Pick<RateRule, 'adjustment' | 'amount' | 'percent'>, currency: string): string {
  if (rule.adjustment === 'FIXED') return `${formatCurrency(rule.amount ?? 0, currency)} per night`;
  const p = Number(rule.percent ?? 0);
  return `${p >= 0 ? '+' : ''}${p}% of the base price`;
}

interface Props {
  propertyId: string;
  timezone?: string;
  currency: string;
  roomTypeId: string;
  roomTypeName: string;
  plans: RatePlan[];
}

/**
 * Seasonal and date-specific prices for one room type. Everything shown here comes from the server: the list of rules and the
 * 14-day preview, which is the price a guest would be quoted (before extra-guest charges and tax) and the rule behind it.
 */
export function RateRulesPanel({ propertyId, timezone, currency, roomTypeId, roomTypeName, plans }: Props) {
  const queryClient = useQueryClient();
  const today = todayInTimeZone(timezone);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RateRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(format(addDays(parseISO(today), 7), 'yyyy-MM-dd'));
  const [days, setDays] = useState<number[]>([]);
  const [kind, setKind] = useState<'FIXED' | 'PERCENT'>('FIXED');
  const [amount, setAmount] = useState(3500);
  const [percent, setPercent] = useState(20);
  const [priority, setPriority] = useState(0);
  const [planId, setPlanId] = useState('');

  const rules = useQuery({
    queryKey: ['rate-rules', propertyId, roomTypeId],
    queryFn: () => ratesApi.listRateRules(propertyId, roomTypeId),
  });
  const preview = useQuery({
    queryKey: ['rate-calendar', propertyId, roomTypeId, today, rules.dataUpdatedAt],
    queryFn: () => ratesApi.rateCalendar(propertyId, { roomTypeId, from: today, to: format(addDays(parseISO(today), 14), 'yyyy-MM-dd') }),
    enabled: plans.length > 0,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['rate-rules', propertyId] });
    await queryClient.invalidateQueries({ queryKey: ['rate-calendar', propertyId] });
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        startDate: start,
        endDate: end,
        daysOfWeek: days.length ? days : undefined,
        adjustment: kind,
        ...(kind === 'FIXED' ? { amount: Math.round(amount * 100) } : { percent }),
        priority,
        ratePlanId: planId || undefined,
      };
      return editing ? ratesApi.updateRateRule(editing._id, body) : ratesApi.createRateRule(propertyId, { ...body, roomTypeId });
    },
    onSuccess: async () => {
      setOpen(false);
      setError(null);
      await refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (r: RateRule) => (r.status === 'ACTIVE' ? ratesApi.deactivateRateRule(r._id) : ratesApi.updateRateRule(r._id, { status: 'ACTIVE' })),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e)),
  });

  const openForm = (r?: RateRule) => {
    setError(null);
    setEditing(r ?? null);
    setName(r?.name ?? '');
    setStart(r?.startDate?.slice(0, 10) ?? today);
    setEnd(r?.endDate?.slice(0, 10) ?? format(addDays(parseISO(today), 7), 'yyyy-MM-dd'));
    setDays(r?.daysOfWeek ?? []);
    setKind(r?.adjustment ?? 'FIXED');
    setAmount(r?.amount ? r.amount / 100 : 3500);
    setPercent(r?.percent !== null && r?.percent !== undefined ? Number(r.percent) : 20);
    setPriority(r?.priority ?? 0);
    setPlanId(r?.ratePlanId ?? '');
    setOpen(true);
  };
  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  const planName = (id?: string | null) => (id ? (plans.find((p) => p._id === id)?.name ?? 'one rate plan') : 'All rate plans');

  return (
    <Card className="shadow-xs">
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div>
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-indigo-600" aria-hidden="true" /> Seasonal &amp; date rates · {roomTypeName}
          </CardTitle>
          <CardDescription>Change the nightly price for a date range or certain weekdays. Existing reservations keep the price they were sold at.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => openForm()} disabled={plans.length === 0}>
          New rate rule
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && !open && <Alert variant="danger" message={error} onClose={() => setError(null)} />}

        <QueryState query={rules} data={rules.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No rate rules" hint="Every night is sold at the rate plan's base price." />} skeletonRows={2}>
          {(list) => (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {list.map((r) => (
                <li key={r._id} className={`flex flex-wrap items-center justify-between gap-2 py-2.5 ${r.status === 'ACTIVE' ? '' : 'opacity-60'}`}>
                  <div className="min-w-0">
                    <div className="font-semibold">
                      {r.name} {r.status !== 'ACTIVE' && <span className="text-xs font-normal text-slate-500">(inactive)</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {formatDate(r.startDate)} to {formatDate(r.endDate)} (end excluded) · {describeDays(r.daysOfWeek)} · {planName(r.ratePlanId)} · priority {r.priority}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold">{describeAdjustment(r, currency)}</span>
                    <Button size="sm" variant="ghost" onClick={() => openForm(r)} aria-label={`Edit rate rule ${r.name}`}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" className={r.status === 'ACTIVE' ? 'text-rose-600' : ''} disabled={toggle.isPending} onClick={() => toggle.mutate(r)} aria-label={`${r.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} rate rule ${r.name}`}>
                      {r.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryState>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Next 14 nights (cheapest active rate plan)</h3>
          <QueryState query={preview} data={preview.data} isEmpty={(d) => d.length === 0} skeletonRows={2}>
            {(days14) => (
              <ul className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 text-xs" aria-label="Effective nightly prices">
                {days14.map((d) => (
                  <li key={d.date} className={`rounded-lg border p-2 ${d.ruleId ? 'border-indigo-300 bg-indigo-50/60 dark:bg-indigo-950/30 dark:border-indigo-800' : 'border-slate-200 dark:border-slate-800'}`}>
                    <div className="text-[10px] text-slate-500">{format(parseISO(d.date), 'EEE d MMM')}</div>
                    <div className="font-bold">{formatCurrency(d.rate, currency)}</div>
                    <div className="truncate text-[10px] text-slate-500" title={d.ruleName ?? 'Base price'}>
                      {d.ruleName ?? 'Base price'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      </CardContent>

      <Dialog isOpen={open} onClose={() => setOpen(false)} title={editing ? `Edit rate rule: ${editing.name}` : 'New rate rule'} description={`Applies to ${roomTypeName}. The end date is not included.`} maxWidth="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!save.isPending) save.mutate();
          }}
          className="space-y-4"
        >
          {error && <Alert variant="danger" message={error} />}
          <Input label="Name *" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali week" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="From *" type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
            <Input label="Until (not included) *" type="date" required min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-slate-700 dark:text-slate-300">Days of the week (none selected = every day)</legend>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((label, d) => (
                <label key={label} className={`cursor-pointer select-none rounded-md border px-2.5 py-1 text-xs font-semibold ${days.includes(d) ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40' : 'border-slate-200 text-slate-600 dark:border-slate-700'}`}>
                  <input type="checkbox" className="sr-only" checked={days.includes(d)} onChange={() => toggleDay(d)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="Price change"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'FIXED' | 'PERCENT')}
              options={[
                { value: 'FIXED', label: 'Set the nightly price' },
                { value: 'PERCENT', label: 'Raise / lower by a percentage' },
              ]}
            />
            {kind === 'FIXED' ? (
              <Input label="Nightly price (₹) *" type="number" required min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            ) : (
              <Input label="Percent (-90 to 500) *" type="number" required min={-90} max={500} step="0.01" value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select label="Applies to" value={planId} onChange={(e) => setPlanId(e.target.value)} options={[{ value: '', label: 'All rate plans of this room type' }, ...plans.map((p) => ({ value: p._id, label: p.name }))]} />
            <Input label="Priority" type="number" min={0} max={1000} value={priority} onChange={(e) => setPriority(Number(e.target.value))} helperText="Higher wins when rules overlap" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={save.isPending} disabled={save.isPending}>
              Save rate rule
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
