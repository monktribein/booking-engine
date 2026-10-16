'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { EmptyState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { formatCurrency } from '@/lib/utils/currency';
import { errorMessage } from '@/lib/utils/errors';
import { formatDate, formatISODate } from '@/lib/utils/dates';
import { Promotion, RatePlan, RatePlanType } from '@/types';
import { ratesApi } from '@/lib/api/rates';
import { roomTypesApi } from '@/lib/api/room-types';
import { Plus, Edit, Tag } from 'lucide-react';
import { addDays } from 'date-fns';

const cancellationFor = (type: RatePlanType) =>
  type === RatePlanType.NON_REFUNDABLE
    ? { refundable: false, penaltyType: 'FULL_STAY', description: 'Non-refundable.' }
    : { refundable: true, freeCancellationHours: 48, penaltyType: 'FIRST_NIGHT', description: 'Free cancellation until 48 hours before check-in; after that the first night is charged.' };

export default function RatesManagementPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<string>('');

  const roomTypes = useQuery({
    queryKey: ['room-types', propertyId],
    queryFn: () => roomTypesApi.list(propertyId as string),
    enabled: !!propertyId,
  });
  const ratePlans = useQuery({
    queryKey: ['rate-plans', propertyId],
    queryFn: () => ratesApi.listRatePlans(propertyId as string),
    enabled: !!propertyId,
  });
  const promotions = useQuery({
    queryKey: ['promotions', propertyId],
    queryFn: () => ratesApi.listPromotions(propertyId as string),
    enabled: !!propertyId,
  });

  const activeTypes = (roomTypes.data ?? []).filter((rt) => rt.status === 'ACTIVE');
  const roomTypeId = selectedRoomTypeId || activeTypes[0]?._id || '';
  const currentRoomType = activeTypes.find((rt) => rt._id === roomTypeId);

  // Rate plan dialog
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<RatePlan | null>(null);
  const [planCode, setPlanCode] = useState('');
  const [planName, setPlanName] = useState('');
  const [planBasePrice, setPlanBasePrice] = useState(2500);
  const [planType, setPlanType] = useState<RatePlanType>(RatePlanType.STANDARD);
  const [error, setError] = useState<string | null>(null);

  const planMutation = useMutation({
    mutationFn: () => {
      const body = { name: planName.trim(), basePrice: Math.round(planBasePrice * 100), type: planType, cancellationPolicy: cancellationFor(planType) };
      return editingPlan
        ? ratesApi.updateRatePlan(editingPlan._id, body as Partial<RatePlan>)
        : ratesApi.createRatePlan(propertyId as string, { ...body, roomTypeId, code: planCode.trim() } as Partial<RatePlan>);
    },
    onSuccess: async () => {
      setModalOpen(false);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['rate-plans', propertyId] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const archiveMutation = useMutation({
    mutationFn: (id: string) => ratesApi.archiveRatePlan(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rate-plans', propertyId] }),
    onError: (e) => setError(errorMessage(e)),
  });

  // Promotion dialog
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoName, setPromoName] = useState('');
  const [promoPercent, setPromoPercent] = useState(10);
  const [promoFrom, setPromoFrom] = useState(formatISODate(new Date()));
  const [promoTo, setPromoTo] = useState(formatISODate(addDays(new Date(), 90)));
  const promoMutation = useMutation({
    mutationFn: () =>
      ratesApi.createPromotion(propertyId as string, {
        code: promoCode.trim().toUpperCase(),
        description: promoName.trim() || promoCode.trim(),
        discountPercent: Number(promoPercent),
        validFrom: promoFrom,
        validTo: promoTo,
        isActive: true,
      } as Partial<Promotion>),
    onSuccess: async () => {
      setPromoOpen(false);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['promotions', propertyId] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const openEdit = (plan?: RatePlan) => {
    setError(null);
    setEditingPlan(plan ?? null);
    setPlanCode(plan?.code ?? '');
    setPlanName(plan?.name ?? '');
    setPlanBasePrice(plan ? plan.basePrice / 100 : (currentRoomType?.basePrice ?? 250000) / 100);
    setPlanType(plan?.type ?? RatePlanType.STANDARD);
    setModalOpen(true);
  };

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  const plansForType = (ratePlans.data ?? []).filter((p) => p.roomTypeId === roomTypeId && p.isActive);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Rate Plans & Promotions</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Manage nightly base rates per room type and discount codes for the booking engine.</p>
        </div>
        <Button size="sm" disabled={!currentRoomType} onClick={() => openEdit()}>
          <Plus className="h-4 w-4 mr-1.5" /> New Rate Plan
        </Button>
      </div>

      {error && !modalOpen && !promoOpen && <Alert variant="danger" message={error} onClose={() => setError(null)} />}

      <QueryState
        query={roomTypes}
        data={roomTypes.data}
        isEmpty={() => activeTypes.length === 0}
        empty={<EmptyState title="No room types" hint="Create a room type before adding rate plans." />}
      >
        {() => (
          <>
            <div className="flex items-center gap-1.5 overflow-x-auto bg-stone-100 dark:bg-slate-800 p-1 rounded-xl text-xs" role="tablist" aria-label="Room type">
              {activeTypes.map((rt) => (
                <button
                  key={rt._id}
                  role="tab"
                  aria-selected={roomTypeId === rt._id}
                  onClick={() => setSelectedRoomTypeId(rt._id)}
                  className={`px-4 py-1.5 rounded-lg font-bold cursor-pointer transition-all whitespace-nowrap ${roomTypeId === rt._id ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 border border-stone-200/60' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'}`}
                >
                  {rt.name}
                </button>
              ))}
            </div>

            <QueryState
              query={ratePlans}
              data={ratePlans.data}
              isEmpty={() => plansForType.length === 0}
              empty={<EmptyState title="No rate plans for this room type" action={<Button size="sm" onClick={() => openEdit()}>New Rate Plan</Button>} />}
            >
              {() => (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {plansForType.map((plan) => (
                    <Card key={plan._id} className="rounded-3xl border border-stone-200/90 hover:border-[#a8c6e5] transition-all overflow-hidden flex flex-col justify-between bg-white dark:bg-slate-900">
                      <CardHeader className="bg-stone-50/60 dark:bg-slate-800/40 p-4 border-b border-stone-100 dark:border-slate-800 flex flex-row items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="inline-flex items-center gap-1.5 rounded-full bg-[#c1d8f0]/40 border border-[#a8c6e5]/60 px-2 py-0.5 text-[10px] font-bold text-slate-800 dark:text-slate-200 mb-1.5">
                            Code: {plan.code}
                          </div>
                          <CardTitle className="text-sm font-bold truncate text-slate-900 dark:text-slate-100">{plan.name}</CardTitle>
                          <CardDescription className="text-xs text-slate-500 line-clamp-2 mt-0.5">
                            {plan.cancellationPolicy?.description || '-'}
                          </CardDescription>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-base font-black text-slate-900 dark:text-slate-100">{formatCurrency(plan.basePrice, plan.currency)}</div>
                          <span className="text-[10px] text-slate-400 font-medium">Base Nightly</span>
                        </div>
                      </CardHeader>
                      <CardContent className="p-3.5 flex items-center justify-between">
                        <Button variant="outline" size="sm" onClick={() => openEdit(plan)} className="h-8 text-xs rounded-xl">
                          <Edit className="h-3.5 w-3.5 mr-1" /> Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs text-rose-600 hover:text-rose-700"
                          disabled={archiveMutation.isPending}
                          onClick={() => {
                            if (window.confirm(`Archive rate plan "${plan.name}"?`)) archiveMutation.mutate(plan._id);
                          }}
                        >
                          Archive
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </QueryState>
          </>
        )}
      </QueryState>

      <Card className="rounded-3xl border border-stone-200/90 overflow-hidden bg-white dark:bg-slate-900">
        <CardHeader className="flex flex-row items-center justify-between p-4 sm:p-5 border-b border-stone-100 dark:border-slate-800">
          <div>
            <CardTitle className="text-base font-bold flex items-center gap-2">
              <Tag className="h-4 w-4 text-slate-700" /> Promotions
            </CardTitle>
            <CardDescription>Guests enter a promo code on the booking page.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setError(null); setPromoOpen(true); }}>
            <Plus className="h-4 w-4 mr-1.5" /> New Promotion
          </Button>
        </CardHeader>
        <CardContent>
          <QueryState query={promotions} data={promotions.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No promotions yet" />} skeletonRows={2}>
            {(list) => (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {list.map((p) => (
                  <li key={p._id} className="flex items-center justify-between py-2.5">
                    <div>
                      <span className="font-bold">{p.code}</span> <span className="text-slate-500 text-xs">{p.description}</span>
                      <div className="text-[11px] text-slate-400">
                        {formatDate(p.validFrom)} – {formatDate(p.validTo)}
                      </div>
                    </div>
                    <span className="text-xs font-semibold">{p.discountPercent}% off {p.isActive ? '' : '(inactive)'}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </CardContent>
      </Card>

      <Dialog isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editingPlan ? `Edit Rate Plan: ${editingPlan.name}` : 'New Rate Plan'} description={`Base price for ${currentRoomType?.name ?? 'room type'}`}>
        <form onSubmit={(e) => { e.preventDefault(); if (!planMutation.isPending) planMutation.mutate(); }} className="space-y-4">
          {error && <Alert variant="danger" message={error} />}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Rate Code *" required disabled={!!editingPlan} placeholder="e.g. STD" value={planCode} onChange={(e) => setPlanCode(e.target.value.toUpperCase())} helperText={editingPlan ? 'Code cannot be changed' : undefined} />
            <Input label="Rate Plan Name *" required placeholder="e.g. Bed & Breakfast" value={planName} onChange={(e) => setPlanName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Base Rate (₹/Night) *" type="number" required min={1} value={planBasePrice} onChange={(e) => setPlanBasePrice(Number(e.target.value))} />
            <Select
              label="Rate Plan Type"
              value={planType}
              onChange={(e) => setPlanType(e.target.value as RatePlanType)}
              options={[
                { value: RatePlanType.STANDARD, label: 'Standard Flexible' },
                { value: RatePlanType.NON_REFUNDABLE, label: 'Non-refundable' },
                { value: RatePlanType.BREAKFAST, label: 'Bed & Breakfast' },
                { value: RatePlanType.CUSTOM, label: 'Custom' },
              ]}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={planMutation.isPending} disabled={planMutation.isPending}>Save Rate Plan</Button>
          </div>
        </form>
      </Dialog>

      <Dialog isOpen={promoOpen} onClose={() => setPromoOpen(false)} title="New Promotion" description="Percentage discount applied to the room total at booking.">
        <form onSubmit={(e) => { e.preventDefault(); if (!promoMutation.isPending) promoMutation.mutate(); }} className="space-y-4">
          {error && <Alert variant="danger" message={error} />}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Promo Code *" required value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())} placeholder="e.g. RADHA10" />
            <Input label="Discount % *" type="number" required min={1} max={100} value={promoPercent} onChange={(e) => setPromoPercent(Number(e.target.value))} />
          </div>
          <Input label="Description" value={promoName} onChange={(e) => setPromoName(e.target.value)} placeholder="Shown to staff" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Valid from *" type="date" required value={promoFrom} onChange={(e) => setPromoFrom(e.target.value)} />
            <Input label="Valid to *" type="date" required min={promoFrom} value={promoTo} onChange={(e) => setPromoTo(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setPromoOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={promoMutation.isPending} disabled={promoMutation.isPending}>Create Promotion</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
