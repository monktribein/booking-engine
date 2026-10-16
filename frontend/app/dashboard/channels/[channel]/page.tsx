'use client';

import React, { useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { channelsApi } from '@/lib/api/channels';
import { ChannelConnectionStatus, ChannelListing } from '@/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { EmptyState, ErrorState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChannelMappingModal } from '@/components/channels/ChannelMappingModal';
import { ConfiguredProviderPanel } from '@/components/channels/ConfiguredProviderPanel';
import { useProperty } from '@/lib/auth/property-context';
import { describeError, errorMessage } from '@/lib/utils/errors';
import { getChannelBadge, getChannelConnectionBadge } from '@/lib/utils/formatters';
import { ArrowLeft, Radio, RefreshCw, AlertTriangle, Unplug, CheckCircle2 } from 'lucide-react';

interface RoomRow {
  key: string;
  externalRoomId: string | null;
  name: string;
}

export default function ChannelDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const rawChannel = (params?.channel as string) || '';
  const channelCode = rawChannel.toUpperCase().replace(/-/g, '_');
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();

  const [actionNotice, setNotice] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);
  const [dismissedReturn, setDismissedReturn] = useState(false);
  const [mapping, setMapping] = useState<{ listing: ChannelListing; room: RoomRow } | null>(null);

  // The backend redirects here after the OAuth consent screen (?connected=CODE)
  const returnNotice = searchParams?.get('connected') && !dismissedReturn ? ({ kind: 'success', text: 'Authorization completed. Review the connection below.' } as const) : null;
  const notice = actionNotice ?? returnNotice;
  const clearNotice = () => {
    setNotice(null);
    setDismissedReturn(true);
  };

  const channels = useQuery({
    queryKey: ['channels', propertyId],
    queryFn: () => channelsApi.list(propertyId as string),
    enabled: !!propertyId,
  });
  const info = channels.data?.find((c) => c.channel === channelCode);
  const isConnected = info?.status === ChannelConnectionStatus.CONNECTED;
  const usable = !!info && info.available && !info.internal;

  const listings = useQuery({
    queryKey: ['channel-listings', propertyId, channelCode],
    queryFn: () => channelsApi.getListings(propertyId as string, channelCode),
    enabled: !!propertyId && isConnected && usable,
    retry: false,
  });

  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['channels', propertyId] }), queryClient.invalidateQueries({ queryKey: ['channel-listings', propertyId, channelCode] })]);
  };

  const connect = useMutation({
    mutationFn: () => channelsApi.connect(propertyId as string, channelCode),
    onSuccess: (res) => {
      if (!res.authorizationUrl) {
        setNotice({ kind: 'danger', text: 'The server did not return an authorization URL.' });
        return;
      }
      window.location.assign(res.authorizationUrl); // official consent screen; the backend redirects back here
    },
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const disconnect = useMutation({
    mutationFn: () => channelsApi.disconnect(propertyId as string, channelCode),
    onSuccess: async () => {
      setNotice({ kind: 'success', text: 'Channel disconnected.' });
      await refresh();
    },
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const sync = useMutation({
    mutationFn: () => channelsApi.triggerSync(propertyId as string, channelCode),
    onSuccess: async (res) => {
      setNotice({ kind: 'success', text: `Sync queued: ${res.queued} job${res.queued === 1 ? '' : 's'}.` });
      await refresh();
    },
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const unmap = useMutation({
    mutationFn: (mappingId: string) => channelsApi.removeMapping(propertyId as string, channelCode, mappingId),
    onSuccess: refresh,
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  const channelBadge = getChannelBadge(channelCode);
  const connBadge = getChannelConnectionBadge(info?.status ?? ChannelConnectionStatus.DISCONNECTED);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/channels" aria-label="Back to channels">
          <Button variant="outline" size="icon" className="h-9 w-9">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{info?.name ?? channelBadge.label} Integration</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Authorize the channel, map its listings to your room types, and sync availability and rates.</p>
        </div>
      </div>

      {notice && <Alert variant={notice.kind} message={notice.text} onClose={clearNotice} />}

      <QueryState query={channels} data={channels.data} isEmpty={() => !info} empty={<EmptyState title="Unknown channel" hint="This channel does not exist." />}>
        {() => (
          <>
            <Card className="shadow-xs overflow-hidden">
              <CardHeader className="bg-slate-50/70 dark:bg-slate-800/40 pb-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl text-white font-bold text-lg shadow-sm" style={{ backgroundColor: channelBadge.iconColor }} aria-hidden="true">
                      {channelBadge.label[0]}
                    </div>
                    <div>
                      <CardTitle className="text-lg font-bold">{info?.name}</CardTitle>
                      <span className={`mt-1 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${connBadge.bg}`}>
                        <span className={`h-2 w-2 rounded-full ${connBadge.dot}`} />
                        {connBadge.label}
                      </span>
                    </div>
                  </div>

                  {usable && (
                    <div className="flex items-center gap-2">
                      {!isConnected ? (
                        info?.configured ? null : <Button isLoading={connect.isPending} disabled={connect.isPending} onClick={() => connect.mutate()} className="font-semibold">
                          <Radio className="h-4 w-4 mr-1.5" /> Connect {info?.name}
                        </Button>
                      ) : (
                        <>
                          <Button variant="outline" size="sm" isLoading={sync.isPending} disabled={sync.isPending} onClick={() => sync.mutate()}>
                            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Sync Now
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            isLoading={disconnect.isPending}
                            disabled={disconnect.isPending}
                            onClick={() => {
                              if (window.confirm(`Disconnect ${info?.name}? Mapped listings stop receiving updates.`)) disconnect.mutate();
                            }}
                          >
                            <Unplug className="h-3.5 w-3.5 mr-1.5" /> Disconnect
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </CardHeader>
            </Card>

            {!usable && (
              <Alert
                variant="warning"
                title="Integration not available yet"
                message={info?.lastError || 'This channel needs approved partner API access before Tirvona can connect to it.'}
              />
            )}

            {usable && info?.configured && <ConfiguredProviderPanel propertyId={propertyId} channel={channelCode} connected={isConnected} />}

            {usable && !isConnected && !info?.configured && (
              <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center space-y-3 bg-white dark:bg-slate-900">
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{info?.name} is not connected</h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto">Authorize Tirvona on the channel&apos;s own consent screen. You never enter API keys here.</p>
              </div>
            )}

            {usable && isConnected && (
              <Card className="shadow-xs overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-bold">Listings & room mapping</CardTitle>
                  <CardDescription>Unmapped rooms are not synchronized.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {listings.isError && describeError(listings.error).kind !== 'unknown' ? (
                    <div className="p-4">
                      <ErrorState error={listings.error} onRetry={() => void listings.refetch()} />
                    </div>
                  ) : (
                    <QueryState query={listings} data={listings.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No listings found on this channel" />}>
                      {(items) => (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Listing</TableHead>
                              <TableHead>Channel room</TableHead>
                              <TableHead>Tirvona room type</TableHead>
                              <TableHead>Rate plans</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {items.flatMap((listing) => {
                              const rooms: RoomRow[] = (listing.externalRooms?.length ? listing.externalRooms : [{ externalRoomId: null as unknown as string, name: 'Entire unit' }]).map((r) => ({
                                key: `${listing._id}:${r.externalRoomId ?? 'unit'}`,
                                externalRoomId: r.externalRoomId ?? null,
                                name: r.name,
                              }));
                              return rooms.map((room) => {
                                const m = listing.roomMappings?.find((x) => (x.externalRoomId ?? null) === room.externalRoomId);
                                return (
                                  <TableRow key={room.key}>
                                    <TableCell>
                                      <div className="font-semibold text-xs text-slate-900 dark:text-slate-100">{listing.name}</div>
                                      <div className="font-mono text-[10px] text-slate-400">{listing.externalListingId}</div>
                                    </TableCell>
                                    <TableCell className="text-xs font-medium">{room.name}</TableCell>
                                    <TableCell className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">{m?.roomTypeName ?? <span className="text-slate-400 font-normal italic">Unmapped</span>}</TableCell>
                                    <TableCell className="text-xs text-slate-500">{m ? `${m.rateMappings?.length ?? 0} mapped` : '-'}</TableCell>
                                    <TableCell>
                                      {m ? (
                                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                          <CheckCircle2 className="h-3 w-3" /> MAPPED
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                          <AlertTriangle className="h-3 w-3" /> UNMAPPED
                                        </span>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-right space-x-1 whitespace-nowrap">
                                      <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs font-semibold" onClick={() => setMapping({ listing, room })}>
                                        {m ? 'Edit Mapping' : 'Map Room'}
                                      </Button>
                                      {m && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-7 px-2 text-xs text-rose-600"
                                          disabled={unmap.isPending}
                                          onClick={() => {
                                            if (window.confirm('Remove this mapping? The room stops syncing.')) unmap.mutate(m._id);
                                          }}
                                        >
                                          Remove
                                        </Button>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                );
                              });
                            })}
                          </TableBody>
                        </Table>
                      )}
                    </QueryState>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </QueryState>

      <ChannelMappingModal
        isOpen={!!mapping}
        onClose={() => setMapping(null)}
        propertyId={propertyId}
        channel={channelCode}
        listing={mapping?.listing ?? null}
        externalRoomId={mapping?.room.externalRoomId ?? null}
        externalRoomName={mapping?.room.name ?? ''}
        onSuccess={async () => {
          setNotice({ kind: 'success', text: 'Mapping saved. Sync jobs have been queued.' });
          await refresh();
        }}
      />
    </div>
  );
}
