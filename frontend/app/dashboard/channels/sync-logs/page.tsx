'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { EmptyState, QueryState } from '@/components/ui/query-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { channelsApi } from '@/lib/api/channels';
import { getChannelBadge } from '@/lib/utils/formatters';
import { formatDate } from '@/lib/utils/dates';
import { errorMessage } from '@/lib/utils/errors';
import { ArrowLeft, RefreshCw } from 'lucide-react';

/** Sync failures are platform-wide data: the backend only serves them to platform admins (others get a 403). */
export default function SyncErrorsPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const query = useQuery({ queryKey: ['sync-errors'], queryFn: () => channelsApi.getSyncErrors(), retry: false });

  const retry = useMutation({
    mutationFn: (id: string) => channelsApi.retrySyncJob(id),
    onSuccess: async () => {
      setNotice({ kind: 'success', text: 'Retry queued.' });
      await queryClient.invalidateQueries({ queryKey: ['sync-errors'] });
    },
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/channels" aria-label="Back to channels">
          <Button variant="outline" size="icon" className="h-9 w-9">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Channel Sync Errors</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Failed or retrying outbound pushes. Platform administrators only.</p>
        </div>
      </div>

      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}

      <Card className="shadow-xs overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-base font-bold">Failed & retrying sync jobs</CardTitle>
            <CardDescription>Jobs that exhausted or are still retrying their attempts</CardDescription>
          </div>
          <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <QueryState query={query} data={query.data} isEmpty={(d) => d.syncJobs.items.length === 0} empty={<EmptyState title="No sync errors" hint="Every recent push succeeded." />}>
            {(data) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead>Job</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>Last error</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.syncJobs.items.map((job) => {
                    const b = getChannelBadge(job.channel);
                    return (
                      <TableRow key={job._id}>
                        <TableCell>
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${b.bg} ${b.text}`}>{b.label}</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{job.type} / {job.entityType}</TableCell>
                        <TableCell className="text-xs font-semibold">{job.status}</TableCell>
                        <TableCell className="text-xs">{job.attempts}/{job.maxAttempts}</TableCell>
                        <TableCell className="text-xs text-slate-500 whitespace-nowrap">{formatDate(job.updatedAt, 'd MMM, h:mm:ss a')}</TableCell>
                        <TableCell className="text-xs max-w-xs truncate text-rose-600">{job.lastError ?? '-'}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={retry.isPending} onClick={() => retry.mutate(job._id)}>
                            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </CardContent>
      </Card>
    </div>
  );
}
