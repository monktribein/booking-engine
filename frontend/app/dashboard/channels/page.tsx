'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { ChannelConnectionStatus } from '@/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { NoPropertyState, QueryState } from '@/components/ui/query-state';
import { useProperty } from '@/lib/auth/property-context';
import { errorMessage } from '@/lib/utils/errors';
import { formatDate } from '@/lib/utils/dates';
import { getChannelBadge, getChannelConnectionBadge } from '@/lib/utils/formatters';
import { RefreshCw, ArrowRight, AlertTriangle, FileText, ChevronDown, ChevronUp, CheckCircle2 } from 'lucide-react';
import { channelsApi } from '@/lib/api/channels';
import { IcalExportPanel } from '@/components/channels/IcalExportPanel';

const INITIAL_CHANNEL_LIMIT = 6;

export default function ChannelManagerPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [showAllChannels, setShowAllChannels] = useState(false);

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
          <Button variant="outline" size="sm" className="rounded-xl border-stone-200">
            <FileText className="h-4 w-4 mr-1.5" /> Sync Errors
          </Button>
        </Link>
      </div>

      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}

      <QueryState query={query} data={query.data} isEmpty={(d) => d.length === 0}>
        {(channels) => {
          const displayed = showAllChannels ? channels : channels.slice(0, INITIAL_CHANNEL_LIMIT);

          return (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <AnimatePresence mode="popLayout">
                  {displayed.map((channel, index) => {
                    const badge = getChannelBadge(channel.channel);
                    const connBadge = getChannelConnectionBadge(channel.status);
                    const isConnected = channel.status === ChannelConnectionStatus.CONNECTED;
                    const slug = channel.channel.toLowerCase().replace(/_/g, '-');
                    const unavailable = !channel.internal && !channel.available;

                    return (
                      <motion.div
                        key={channel.channel}
                        layout
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.25, delay: index * 0.04 }}
                        whileHover={{ y: -2 }}
                        className="h-full"
                      >
                        <Card className="rounded-3xl border border-stone-200/90 hover:border-[#a8c6e5] transition-all flex flex-col justify-between h-full bg-white dark:bg-slate-900 overflow-hidden">
                          <div>
                            <CardHeader className="p-4 border-b border-stone-100 dark:border-slate-800">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div
                                    className="flex h-8 w-8 items-center justify-center rounded-xl text-white font-black text-xs shrink-0"
                                    style={{ backgroundColor: badge.iconColor }}
                                    aria-hidden="true"
                                  >
                                    {badge.label[0]}
                                  </div>
                                  <div className="min-w-0">
                                    <CardTitle className="text-sm font-bold truncate text-slate-900 dark:text-slate-100">
                                      {channel.name}
                                    </CardTitle>
                                    <CardDescription className="capitalize text-[11px] text-slate-400">
                                      {channel.internal ? 'Built-in channel' : `${channel.kind.toLowerCase()} integration`}
                                    </CardDescription>
                                  </div>
                                </div>
                                {channel.internal ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border bg-emerald-50 text-emerald-700 border-emerald-200/70 shrink-0">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Always on
                                  </span>
                                ) : unavailable ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border bg-amber-50 text-amber-700 border-amber-200/70 shrink-0">
                                    Partner access needed
                                  </span>
                                ) : (
                                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${connBadge.bg} shrink-0`}>
                                    <span className={`h-1.5 w-1.5 rounded-full ${connBadge.dot}`} />
                                    {connBadge.label}
                                  </span>
                                )}
                              </div>
                            </CardHeader>

                            <CardContent className="p-3.5 space-y-3 text-xs">
                              {channel.internal ? (
                                <div className="space-y-1.5 p-2.5 rounded-xl bg-stone-50/70 dark:bg-slate-800/40 border border-stone-100 dark:border-slate-800 text-[11px]">
                                  <div className="flex items-center justify-between text-slate-500">
                                    <span>Sync Status:</span>
                                    <span className="font-bold text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                                      <CheckCircle2 className="h-3 w-3" /> Realtime Active
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between text-slate-500">
                                    <span>Commission:</span>
                                    <span className="font-semibold text-slate-800 dark:text-slate-200">0% Direct Booking</span>
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-1.5 p-2.5 rounded-xl bg-stone-50/70 dark:bg-slate-800/40 border border-stone-100 dark:border-slate-800 text-[11px]">
                                  <div className="flex justify-between text-slate-500">
                                    <span>Last synchronization:</span>
                                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                                      {channel.lastSyncAt ? formatDate(channel.lastSyncAt, 'd MMM, h:mm a') : 'Never'}
                                    </span>
                                  </div>
                                  <div className="flex justify-between text-slate-500">
                                    <span>Mapped room types:</span>
                                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                                      {channel.mappedCount ?? 0} mapped • {channel.listingsCount ?? 0} listing{channel.listingsCount === 1 ? '' : 's'}
                                    </span>
                                  </div>
                                </div>
                              )}

                              {channel.lastError && (
                                <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 p-2 text-[11px] text-rose-700 dark:text-rose-300 border border-rose-200 flex items-start gap-1.5">
                                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-600 mt-0.5" />
                                  <div className="flex-1 line-clamp-2">{channel.lastError}</div>
                                </div>
                              )}
                            </CardContent>
                          </div>

                          <div className="p-3 border-t border-stone-100 dark:border-slate-800 flex items-center justify-between gap-2 bg-stone-50/30">
                            {isConnected && !channel.internal && channel.available && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2.5 text-xs rounded-xl"
                                isLoading={syncing === channel.channel}
                                disabled={syncMutation.isPending}
                                onClick={() => syncMutation.mutate(channel.channel)}
                              >
                                <RefreshCw className="h-3 w-3 mr-1" /> Sync Now
                              </Button>
                            )}
                            {!channel.internal ? (
                              <Link href={`/dashboard/channels/${slug}`} className="ml-auto">
                                <Button
                                  size="sm"
                                  className="h-7 px-3 text-xs font-semibold rounded-xl bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 border border-[#a8c6e5] cursor-pointer"
                                >
                                  Manage Channel <ArrowRight className="h-3 w-3 ml-1" />
                                </Button>
                              </Link>
                            ) : (
                              <div className="text-[10px] text-slate-400 font-medium ml-auto flex items-center gap-1">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Integrated
                              </div>
                            )}
                          </div>
                        </Card>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>

              {channels.length > INITIAL_CHANNEL_LIMIT && (
                <div className="pt-2 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setShowAllChannels(!showAllChannels)}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] px-6 py-2.5 text-xs transition-all hover:-translate-y-0.5 cursor-pointer"
                  >
                    {showAllChannels ? (
                      <>
                        Show Less <ChevronUp className="h-4 w-4" />
                      </>
                    ) : (
                      <>
                        View All ({channels.length} Channels) <ChevronDown className="h-4 w-4" />
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        }}
      </QueryState>

      <IcalExportPanel propertyId={propertyId} />
    </div>
  );
}
