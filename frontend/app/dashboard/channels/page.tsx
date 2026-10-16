'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChannelConnectionStatus } from '@/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { NoPropertyState, QueryState } from '@/components/ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { errorMessage } from '@/lib/utils/errors';
import { formatDate } from '@/lib/utils/dates';
import { getChannelBadge, getChannelConnectionBadge } from '@/lib/utils/formatters';
import { RefreshCw, ArrowRight, AlertTriangle, FileText } from 'lucide-react';
import { channelsApi } from '@/lib/api/channels';
import { IcalExportPanel } from '@/components/channels/IcalExportPanel';

export default function ChannelManagerPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['channels', propertyId],
    queryFn: () => channelsApi.list(propertyId as string),
    enabled: !!propertyId,
  });

  const syncMutation = useMutation({
    mutationFn: (channel: string) => channelsApi.triggerSync(propertyId as string, channel),
    onMutate: (channel) => setSyncing(channel),
    onSuccess: async (res, channel) => {
      setNotice({ kind: 'success', text: `Sync queued for ${channel}: ${res.queued} job${res.queued === 1 ? '' : 's'}.` });
      await queryClient.invalidateQueries({ queryKey: ['channels', propertyId] });
    },
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
    onSettled: () => setSyncing(null),
  });

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Channel Manager</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Connect channels, map listings to room types, and keep availability in sync.</p>
        </div>
        <Link href="/dashboard/channels/sync-logs">
          <Button variant="outline" size="sm">
            <FileText className="h-4 w-4 mr-1.5" /> Sync Errors
          </Button>
        </Link>
      </div>

      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}

      <QueryState query={query} data={query.data} isEmpty={(d) => d.length === 0}>
        {(channels) => (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {channels.map((channel) => {
              const badge = getChannelBadge(channel.channel);
              const connBadge = getChannelConnectionBadge(channel.status);
              const isConnected = channel.status === ChannelConnectionStatus.CONNECTED;
              const slug = channel.channel.toLowerCase().replace(/_/g, '-');
              const unavailable = !channel.internal && !channel.available;

              return (
                <Card key={channel.channel} className="overflow-hidden hover:shadow-md transition-all flex flex-col justify-between">
                  <div>
                    <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800/80">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl text-white font-bold text-sm shadow-xs" style={{ backgroundColor: badge.iconColor }} aria-hidden="true">
                            {badge.label[0]}
                          </div>
                          <div>
                            <CardTitle className="text-base font-bold">{channel.name}</CardTitle>
                            <CardDescription className="capitalize">{channel.internal ? 'built-in channel' : `${channel.kind.toLowerCase()} integration`}</CardDescription>
                          </div>
                        </div>
                        {channel.internal ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">Always on</span>
                        ) : unavailable ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border bg-amber-50 text-amber-700 border-amber-200">Partner access needed</span>
                        ) : (
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${connBadge.bg}`}>
                            <span className={`h-2 w-2 rounded-full ${connBadge.dot}`} />
                            {connBadge.label}
                          </span>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-4 pt-4 text-xs">
                      {!channel.internal && (
                        <div className="space-y-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50">
                          <div className="flex justify-between text-slate-500">
                            <span>Last synchronization:</span>
                            <span className="font-semibold text-slate-800 dark:text-slate-200">{channel.lastSyncAt ? formatDate(channel.lastSyncAt, 'd MMM, h:mm a') : 'Never'}</span>
                          </div>
                          <div className="flex justify-between text-slate-500">
                            <span>Mapped room types:</span>
                            <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                              {channel.mappedCount ?? 0} mapped • {channel.listingsCount ?? 0} listing{channel.listingsCount === 1 ? '' : 's'}
                            </span>
                          </div>
                        </div>
                      )}

                      {channel.lastError && (
                        <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 p-2.5 text-xs text-rose-700 dark:text-rose-300 border border-rose-200 flex items-start gap-2">
                          <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                          <div className="flex-1">{channel.lastError}</div>
                        </div>
                      )}
                    </CardContent>
                  </div>

                  <div className="p-4 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                    {isConnected && !channel.internal && channel.available && (
                      <Button variant="outline" size="sm" className="h-8 text-xs" isLoading={syncing === channel.channel} disabled={syncMutation.isPending} onClick={() => syncMutation.mutate(channel.channel)}>
                        <RefreshCw className="h-3.5 w-3.5 mr-1" /> Sync Now
                      </Button>
                    )}
                    {!channel.internal && (
                      <Link href={`/dashboard/channels/${slug}`} className="ml-auto">
                        <Button size="sm" className="h-8 text-xs font-semibold">
                          Manage Channel <ArrowRight className="h-3.5 w-3.5 ml-1" />
                        </Button>
                      </Link>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </QueryState>

      <IcalExportPanel propertyId={propertyId} />
    </div>
  );
}
