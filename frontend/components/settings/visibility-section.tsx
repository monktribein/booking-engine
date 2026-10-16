'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { QueryState } from '@/components/ui/query-state';
import { visibilityApi, type Visibility } from '@/lib/api/partners';
import { errorMessage } from '@/lib/utils/errors';
import { MarketplaceStatus } from '@/types';

type Notice = { kind: 'success' | 'danger'; text: string };

const MARKETPLACE_LABEL: Record<MarketplaceStatus, { text: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
  [MarketplaceStatus.NOT_LISTED]: { text: 'Not listed', variant: 'default' },
  [MarketplaceStatus.REQUESTED]: { text: 'Waiting for review', variant: 'warning' },
  [MarketplaceStatus.APPROVED]: { text: 'Listed', variant: 'success' },
  [MarketplaceStatus.REJECTED]: { text: 'Not approved', variant: 'danger' },
  [MarketplaceStatus.SUSPENDED]: { text: 'Suspended by Tirvona', variant: 'danger' },
};

/**
 * Who can see and book this property. The owner decides (a property is private until published), and joining the Tirvona
 * marketplace needs the owner's explicit consent and the platform's approval. The server enforces every rule shown here.
 */
export function VisibilitySection({ propertyId, canManage, onNotice }: { propertyId: string; canManage: boolean; onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const visibility = useQuery({ queryKey: ['visibility', propertyId], queryFn: () => visibilityApi.get(propertyId) });
  const [consent, setConsent] = useState(false);
  const refresh = (v: Visibility) => {
    queryClient.setQueryData(['visibility', propertyId], v);
    void queryClient.invalidateQueries({ queryKey: ['properties', 'mine'] });
  };
  const fail = (e: unknown) => onNotice({ kind: 'danger', text: errorMessage(e) });

  const direct = useMutation({
    mutationFn: (on: boolean) => visibilityApi.setDirectBooking(propertyId, on),
    onSuccess: (v) => {
      refresh(v);
      onNotice({ kind: 'success', text: v.directBookingEnabled ? 'Your booking page is now public.' : 'Your booking page is now private.' });
    },
    onError: fail,
  });
  const request = useMutation({
    mutationFn: () => visibilityApi.requestMarketplace(propertyId),
    onSuccess: (v) => {
      refresh(v);
      setConsent(false);
      onNotice({ kind: 'success', text: 'Request sent. The Tirvona team will review your listing.' });
    },
    onError: fail,
  });
  const withdraw = useMutation({
    mutationFn: () => visibilityApi.withdrawMarketplace(propertyId),
    onSuccess: (v) => {
      refresh(v);
      onNotice({ kind: 'success', text: 'Removed from the marketplace. Your consent was withdrawn.' });
    },
    onError: fail,
  });

  return (
    <QueryState query={visibility} data={visibility.data} skeletonRows={3}>
      {(v) => {
        const m = MARKETPLACE_LABEL[v.marketplace.status];
        const suspended = v.propertyStatus === 'SUSPENDED';
        const marketplaceSuspended = v.marketplace.status === MarketplaceStatus.SUSPENDED;
        const canRequest = canManage && !suspended && !marketplaceSuspended && (v.marketplace.status === MarketplaceStatus.NOT_LISTED || v.marketplace.status === MarketplaceStatus.REJECTED);
        return (
          <div className="space-y-6">
            {suspended && <Alert variant="danger" title="This property is suspended by Tirvona" message={`${v.suspendedReason ?? 'No reason given.'} It cannot be booked, and you cannot change its visibility until the suspension is lifted.`} />}

            <Card className="shadow-xs">
              <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
                <CardTitle className="text-base font-bold">Booking page</CardTitle>
                <CardDescription>
                  Your property&apos;s own page where guests check availability and book directly. New properties are private until you publish them.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 p-5 text-xs">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant={v.directBookingEnabled ? 'success' : 'default'}>{v.directBookingEnabled ? 'Public' : 'Private'}</Badge>
                  {v.directBookingEnabled && v.propertyStatus === 'ACTIVE' && (
                    <a className="inline-flex items-center gap-1 font-semibold text-indigo-600 hover:underline" href={`/stays/${v.slug}`} target="_blank" rel="noreferrer">
                      Open your public page <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
                {v.propertyStatus !== 'ACTIVE' && !suspended && <p className="text-amber-700 dark:text-amber-300">The property status is {v.propertyStatus.toLowerCase()}: only active properties can be booked, whatever you choose here.</p>}
                <div>
                  <Button
                    variant={v.directBookingEnabled ? 'outline' : 'primary'}
                    size="sm"
                    disabled={!canManage || suspended || direct.isPending}
                    isLoading={direct.isPending}
                    onClick={() => direct.mutate(!v.directBookingEnabled)}
                  >
                    {v.directBookingEnabled ? 'Make booking page private' : 'Publish booking page'}
                  </Button>
                  {!canManage && <span className="ml-3 text-slate-500">Only the owner can change this.</span>}
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-xs">
              <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-base font-bold">Tirvona marketplace</CardTitle>
                    <CardDescription>List this property in public search so guests who don&apos;t know you can find it. Optional.</CardDescription>
                  </div>
                  <Badge variant={m.variant}>{m.text}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-5 text-xs">
                {v.marketplace.status === MarketplaceStatus.REJECTED && <Alert variant="warning" title="Not approved" message={v.marketplace.note ?? 'The Tirvona team did not approve this listing. Fix the points they mention and ask again.'} />}
                {marketplaceSuspended && <Alert variant="danger" title="Removed by Tirvona" message={v.marketplace.note ?? 'This listing was taken off the marketplace. Contact Tirvona support.'} />}
                {v.marketplace.status === MarketplaceStatus.REQUESTED && <Alert variant="info" message="Your request is waiting for review. Your property is not in search until it is approved." />}
                {v.marketplace.status === MarketplaceStatus.APPROVED && <Alert variant="success" message="Your property is listed on the marketplace and appears in guest search." />}

                <div>
                  <h3 className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-300">Listing requirements</h3>
                  <ul className="space-y-1.5">
                    {v.requirements.map((r) => (
                      <li key={r.key} className="flex items-center gap-2">
                        {r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="done" /> : <Circle className="h-4 w-4 text-slate-300" aria-label="missing" />}
                        <span className={r.ok ? 'text-slate-600 dark:text-slate-400' : 'font-medium text-slate-900 dark:text-slate-100'}>{r.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {canRequest && (
                  <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                    <label className="flex items-start gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                      <span>
                        I agree to list this property publicly on the Tirvona marketplace. Its name, description, photos, location, amenities and prices will be visible to everyone, and it will follow the marketplace rules. I can withdraw this at any time.
                      </span>
                    </label>
                    <Button size="sm" disabled={!consent || !v.eligibleForMarketplace || request.isPending} isLoading={request.isPending} onClick={() => request.mutate()}>
                      Request marketplace listing
                    </Button>
                    {!v.eligibleForMarketplace && <p className="text-amber-700 dark:text-amber-300">Complete the requirements above first.</p>}
                  </div>
                )}

                {canManage && (v.marketplace.status === MarketplaceStatus.REQUESTED || v.marketplace.status === MarketplaceStatus.APPROVED) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={withdraw.isPending}
                    onClick={() => {
                      if (window.confirm('Remove this property from the marketplace? Your consent is withdrawn and it disappears from search.')) withdraw.mutate();
                    }}
                  >
                    {v.marketplace.status === MarketplaceStatus.REQUESTED ? 'Cancel request' : 'Leave the marketplace'}
                  </Button>
                )}
                {!canManage && <p className="text-slate-500">Only the owner can request or withdraw a listing.</p>}
              </CardContent>
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}
