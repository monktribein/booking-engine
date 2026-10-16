'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { QueryState } from '@/components/ui/query-state';
import { providersApi } from '@/lib/api/providers';
import { roomTypesApi } from '@/lib/api/room-types';
import { errorMessage } from '@/lib/utils/errors';
import { formatDate } from '@/lib/utils/dates';

/**
 * Calendar addresses Tirvona publishes, for platforms that can import an iCal link. They show only the nights a room type is sold out.
 * The address is shown once and works like a password.
 */
export function IcalExportPanel({ propertyId }: { propertyId: string }) {
  const queryClient = useQueryClient();
  const [roomTypeId, setRoomTypeId] = useState('');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ url: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feeds = useQuery({ queryKey: ['ical-feeds', propertyId], queryFn: () => providersApi.icalFeeds(propertyId) });
  const roomTypes = useQuery({ queryKey: ['room-types', propertyId], queryFn: () => roomTypesApi.list(propertyId) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ical-feeds', propertyId] });
  const create = useMutation({
    mutationFn: () => providersApi.createIcalFeed(propertyId, roomTypeId, label.trim()),
    onSuccess: async (r) => {
      setCreated({ url: r.url, note: r.note });
      setLabel('');
      setError(null);
      await refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => providersApi.revokeIcalFeed(propertyId, id),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e)),
  });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard not available: the address is selectable on screen */
    }
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-bold">Calendars you publish</CardTitle>
        <CardDescription>
          For platforms that can import a calendar link. It marks the nights a room type is fully booked or closed, and nothing else: no prices, no guest details,
          and no count of rooms left, so a room type with several rooms stays open on the other platform until the last room is taken.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        {error && <Alert variant="danger" message={error} onClose={() => setError(null)} />}
        {created && (
          <Alert variant="success" title="Calendar address created. Copy it now, it is not shown again." message={created.url} onClose={() => setCreated(null)} />
        )}
        {created && <Button variant="outline" size="sm" onClick={() => void copy(created.url)}>Copy address</Button>}

        <form className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Select label="Room type" value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} options={[{ value: '', label: 'Choose…' }, ...(roomTypes.data ?? []).map((r) => ({ value: r._id, label: r.name }))]} />
          <Input label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="For Airbnb" />
          <Button type="submit" size="sm" disabled={!roomTypeId} isLoading={create.isPending}>Create calendar address</Button>
        </form>

        <QueryState query={feeds} data={feeds.data} skeletonRows={2}>
          {(rows) =>
            rows.length === 0 ? (
              <p className="text-slate-500">No calendar addresses yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((f) => (
                  <li key={f._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <span className="font-semibold">{f.roomType}</span> {f.label ? <span className="text-slate-500">• {f.label}</span> : null}
                      <div className="text-slate-500">
                        Created {formatDate(f.createdAt, 'd MMM yyyy')} • {f.lastFetchedAt ? `last read ${formatDate(f.lastFetchedAt, 'd MMM, h:mm a')}` : 'never read'}
                      </div>
                    </div>
                    {f.revokedAt ? (
                      <Badge variant="danger">revoked</Badge>
                    ) : (
                      <Button variant="ghost" size="sm" className="text-rose-600" aria-label={`Revoke calendar ${f.roomType}`} onClick={() => { if (window.confirm('Revoke this address? The other platform stops receiving updates.')) revoke.mutate(f._id); }}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </QueryState>
      </CardContent>
    </Card>
  );
}
