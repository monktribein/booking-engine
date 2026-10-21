'use client';

import React, { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Input } from '../ui/input';
import { Alert } from '../ui/alert';
import { ErrorState } from '../ui/query-state';
import { ChannelListing, MarkupType } from '@/types';
import { channelsApi } from '@/lib/api/channels';
import { ratesApi } from '@/lib/api/rates';
import { roomTypesApi } from '@/lib/api/room-types';
import { errorMessage } from '@/lib/utils/errors';
import { ArrowRight } from 'lucide-react';

interface RateRow {
  externalRatePlanId: string;
  name: string;
  ratePlanId: string; // '' = not mapped
  markupType: MarkupType;
  markupValue: number; // percent, or rupees for FIXED (sent as paise)
}

/**
 * Maps one external room of a listing to a Tirvona room type, plus its external rate plans to Tirvona rate plans.
 * Backend contract: POST /properties/:id/channels/:channel/mappings
 */
export function ChannelMappingModal({
  isOpen,
  onClose,
  propertyId,
  channel,
  listing,
  externalRoomId,
  externalRoomName,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  propertyId: string;
  channel: string;
  listing: ChannelListing | null;
  externalRoomId: string | null;
  externalRoomName: string;
  onSuccess?: () => void;
}) {
  if (!listing) return null;
  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={`Map ${listing.name}`} description={`${externalRoomName} • ${listing.externalListingId} (${channel})`} maxWidth="lg">
      {/* Mounted only while open and keyed per target, so its state always starts from the saved mapping. */}
      <MappingForm key={`${listing._id}:${externalRoomId ?? 'unit'}`} onClose={onClose} propertyId={propertyId} channel={channel} listing={listing} externalRoomId={externalRoomId} externalRoomName={externalRoomName} onSuccess={onSuccess} />
    </Dialog>
  );
}

function MappingForm({
  onClose,
  propertyId,
  channel,
  listing,
  externalRoomId,
  externalRoomName,
  onSuccess,
}: {
  onClose: () => void;
  propertyId: string;
  channel: string;
  listing: ChannelListing;
  externalRoomId: string | null;
  externalRoomName: string;
  onSuccess?: () => void;
}) {
  const existing = listing.roomMappings?.find((m) => (m.externalRoomId ?? null) === externalRoomId);
  const [roomTypeId, setRoomTypeId] = useState(existing?.roomTypeId ?? '');
  const [rows, setRows] = useState<RateRow[]>(() =>
    (listing.externalRatePlans ?? [])
      .filter((rp) => (rp.externalRoomId ?? null) === externalRoomId)
      .map((rp) => {
        const prior = existing?.rateMappings?.find((x) => x.externalRatePlanId === rp.externalRatePlanId);
        return {
          externalRatePlanId: rp.externalRatePlanId,
          name: rp.name,
          ratePlanId: prior?.ratePlanId ?? '',
          markupType: prior?.markupType ?? MarkupType.NONE,
          markupValue: prior ? (prior.markupType === MarkupType.FIXED ? prior.markupValue / 100 : prior.markupValue) : 0,
        };
      })
  );
  const [isSaving, setIsSaving] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const roomTypes = useQuery({ queryKey: ['room-types', propertyId], queryFn: () => roomTypesApi.list(propertyId) });
  const ratePlans = useQuery({ queryKey: ['rate-plans', propertyId], queryFn: () => ratesApi.listRatePlans(propertyId) });

  const activeTypes = (roomTypes.data ?? []).filter((rt) => rt.status === 'ACTIVE');
  const effectiveRoomTypeId = roomTypeId || activeTypes[0]?._id || '';
  const plansForType = (ratePlans.data ?? []).filter((p) => p.roomTypeId === effectiveRoomTypeId && p.isActive);

  const update = (i: number, patch: Partial<RateRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving.current) return;
    if (!effectiveRoomTypeId) {
      setError('Select a Tirvona room type to complete the mapping.');
      return;
    }
    saving.current = true;
    setIsSaving(true);
    setError(null);
    try {
      await channelsApi.saveMappings(propertyId, channel, {
        mappings: [
          {
            externalListingId: listing.externalListingId,
            externalRoomId: externalRoomId ?? undefined,
            roomTypeId: effectiveRoomTypeId,
            ratePlans: rows
              .filter((r) => r.ratePlanId)
              .map((r) => ({
                externalRatePlanId: r.externalRatePlanId,
                ratePlanId: r.ratePlanId,
                markupType: r.markupType,
                markupValue: r.markupType === MarkupType.NONE ? 0 : r.markupType === MarkupType.FIXED ? Math.round(r.markupValue * 100) : r.markupValue,
              })),
          },
        ],
      });
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  };

  const loadFailed = roomTypes.isError ? roomTypes : ratePlans.isError ? ratePlans : null;

  return (
    <>
      {loadFailed ? (
        <ErrorState error={loadFailed.error} onRetry={() => void loadFailed.refetch()} />
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          {error && <Alert variant="danger" message={error} />}

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 bg-slate-50/70 dark:bg-slate-800/40 space-y-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold flex-1 truncate">{externalRoomName}</div>
              <ArrowRight className="h-5 w-5 text-indigo-600 shrink-0" aria-hidden="true" />
              <div className="flex-1">
                <Select
                  aria-label="Tirvona room type"
                  value={effectiveRoomTypeId}
                  onChange={(e) => {
                    setRoomTypeId(e.target.value);
                    setRows((prev) => prev.map((r) => ({ ...r, ratePlanId: '' })));
                  }}
                  options={activeTypes.map((rt) => ({ value: rt._id, label: `${rt.name} (max ${rt.maxOccupancy})` }))}
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Rate plan mapping & markup</h4>
            {rows.length === 0 ? (
              <p className="text-xs text-slate-500">This channel room exposes no rate plans. Availability will still be synchronized.</p>
            ) : (
              rows.map((r, i) => (
                <div key={r.externalRatePlanId} className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 pb-2">{r.name}</div>
                  <Select
                    label="Tirvona rate plan"
                    value={r.ratePlanId}
                    onChange={(e) => update(i, { ratePlanId: e.target.value })}
                    options={[{ value: '', label: 'Do not map' }, ...plansForType.map((p) => ({ value: p._id, label: p.name }))]}
                  />
                  <Select
                    label="Markup"
                    value={r.markupType}
                    onChange={(e) => update(i, { markupType: e.target.value as MarkupType })}
                    options={[
                      { value: MarkupType.NONE, label: 'None' },
                      { value: MarkupType.PERCENTAGE, label: 'Percent (%)' },
                      { value: MarkupType.FIXED, label: 'Fixed (₹)' },
                    ]}
                  />
                  <Input
                    label="Value"
                    type="number"
                    min={0}
                    disabled={r.markupType === MarkupType.NONE}
                    value={r.markupValue}
                    onChange={(e) => update(i, { markupValue: Number(e.target.value) })}
                  />
                </div>
              ))
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isSaving} disabled={isSaving || !effectiveRoomTypeId}>
              Save Mapping
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
