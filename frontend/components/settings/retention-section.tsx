'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { QueryState } from '@/components/ui/query-state';
import { retentionApi, type RetentionResult } from '@/lib/api/retention';
import { formatDateTime } from '@/lib/utils/dates';
import { errorMessage } from '@/lib/utils/errors';

type Notice = { kind: 'success' | 'danger'; text: string };

/**
 * Personal-data retention. Owners only. Nothing is ever deleted or anonymised until an owner has chosen the periods, looked at a
 * dry run and approved the policy; changing a period withdraws the approval. Bookings, amounts, payments and reports are kept:
 * only the guest's identifying details are replaced.
 */
export function RetentionSection({ onNotice }: { onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['retention'], queryFn: retentionApi.get });
  const [guestDays, setGuestDays] = useState<string | null>(null);
  const [notifDays, setNotifDays] = useState<string | null>(null);
  const [inboundDays, setInboundDays] = useState<string | null>(null);
  const [preview, setPreview] = useState<RetentionResult | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['retention'] });
  const fail = (e: unknown) => onNotice({ kind: 'danger', text: errorMessage(e) });

  const save = useMutation({
    mutationFn: (p: { guest: string; notif: string; inbound: string }) =>
      retentionApi.set({
        guestAnonymizeAfterDays: p.guest === '' ? null : Number(p.guest),
        notificationRedactAfterDays: p.notif === '' ? null : Number(p.notif),
        inboundPayloadRedactAfterDays: p.inbound === '' ? null : Number(p.inbound),
      }),
    onSuccess: async () => {
      setPreview(null);
      setGuestDays(null);
      setNotifDays(null);
      setInboundDays(null);
      await refresh();
      onNotice({ kind: 'success', text: 'Periods saved. The policy must be approved again before anything runs.' });
    },
    onError: fail,
  });
  const dry = useMutation({ mutationFn: retentionApi.dryRun, onSuccess: setPreview, onError: fail });
  const approve = useMutation({
    mutationFn: retentionApi.approve,
    onSuccess: async () => {
      await refresh();
      onNotice({ kind: 'success', text: 'Policy approved. Scheduled runs (if enabled on the server) may now apply it.' });
    },
    onError: fail,
  });
  const disable = useMutation({ mutationFn: retentionApi.disable, onSuccess: refresh, onError: fail });
  const run = useMutation({
    mutationFn: retentionApi.run,
    onSuccess: async (r) => {
      setPreview(null);
      await refresh();
      onNotice({ kind: 'success', text: `Done: ${r.summary.guests} guest(s) anonymised${r.moreGuests ? ' (more remain; run again)' : ''}, ${r.summary.notifications} message(s) and ${r.summary.inboundEvents} channel event(s) blanked.` });
    },
    onError: fail,
  });

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle className="text-base font-bold flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-indigo-600" aria-hidden="true" /> Personal-data retention
        </CardTitle>
        <CardDescription>
          After a guest has no open booking and their last stay ended more than the chosen number of days ago, their name, contact details, documents and notes are
          replaced with &quot;Anonymized Guest&quot;. Bookings, dates, amounts, payments, refunds, reports and the audit trail stay. Choose periods that fit your legal and tax
          obligations; none is set by default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <QueryState query={overview} data={overview.data} skeletonRows={3}>
          {({ policy, runs }) => {
            const guestValue = guestDays ?? (policy.guestAnonymizeAfterDays?.toString() ?? '');
            const notifValue = notifDays ?? (policy.notificationRedactAfterDays?.toString() ?? '');
            const inboundValue = inboundDays ?? (policy.inboundPayloadRedactAfterDays?.toString() ?? '');
            const dirty =
              guestValue !== (policy.guestAnonymizeAfterDays?.toString() ?? '') ||
              notifValue !== (policy.notificationRedactAfterDays?.toString() ?? '') ||
              inboundValue !== (policy.inboundPayloadRedactAfterDays?.toString() ?? '');
            const hasPeriods = policy.guestAnonymizeAfterDays !== null || policy.notificationRedactAfterDays !== null || policy.inboundPayloadRedactAfterDays !== null;
            return (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold">Status:</span>
                  {policy.enabled ? <Badge variant="success">Approved and active</Badge> : policy.awaitingApproval ? <Badge variant="warning">Waiting for approval</Badge> : <Badge>Not configured</Badge>}
                  {policy.approvedAt && <span className="text-xs text-slate-500">approved {formatDateTime(policy.approvedAt)}</span>}
                </div>

                <form
                  className="grid grid-cols-1 sm:grid-cols-3 gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!save.isPending) save.mutate({ guest: guestValue, notif: notifValue, inbound: inboundValue });
                  }}
                >
                  <Input label="Anonymise guests after (days)" type="number" min={30} max={3650} value={guestValue} onChange={(e) => setGuestDays(e.target.value)} placeholder="never" helperText="Days after their last stay ended (30 to 3650). Empty = never." />
                  <Input label="Blank sent messages after (days)" type="number" min={7} max={3650} value={notifValue} onChange={(e) => setNotifDays(e.target.value)} placeholder="never" helperText="E-mail and SMS recipient, subject and text (7 to 3650). Empty = never." />
                  <Input label="Blank channel payloads after (days)" type="number" min={7} max={3650} value={inboundValue} onChange={(e) => setInboundDays(e.target.value)} placeholder="never" helperText="Raw OTA booking notifications (guest name and contact inside). Empty = never." />
                  <div className="sm:col-span-3 flex flex-wrap gap-2">
                    <Button type="submit" size="sm" isLoading={save.isPending} disabled={!dirty || save.isPending}>
                      Save periods
                    </Button>
                    <Button type="button" size="sm" variant="outline" isLoading={dry.isPending} disabled={dirty || !hasPeriods || dry.isPending} onClick={() => dry.mutate()}>
                      Preview (dry run)
                    </Button>
                    {!policy.enabled ? (
                      <Button type="button" size="sm" disabled={dirty || !hasPeriods || approve.isPending} isLoading={approve.isPending} onClick={() => approve.mutate()}>
                        Approve policy
                      </Button>
                    ) : (
                      <>
                        <Button type="button" size="sm" variant="outline" disabled={disable.isPending} onClick={() => disable.mutate()}>
                          Switch off
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          isLoading={run.isPending}
                          disabled={run.isPending}
                          onClick={() => {
                            if (window.confirm('Anonymise eligible guests now? This cannot be undone.')) run.mutate();
                          }}
                        >
                          Run now
                        </Button>
                      </>
                    )}
                  </div>
                </form>

                {preview && (
                  <Alert
                    variant="info"
                    message={`Dry run: a run now would anonymise ${preview.summary.guests} guest(s) (${preview.summary.reservations} reservation snapshot(s)) and blank ${preview.summary.notifications} message(s) and ${preview.summary.inboundEvents} channel event payload(s). Nothing was changed.`}
                    onClose={() => setPreview(null)}
                  />
                )}

                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Recent runs (counts only)</h3>
                  {runs.length === 0 ? (
                    <p className="text-xs text-slate-500">No runs yet.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                      {runs.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                          <span>
                            {formatDateTime(r.createdAt)} · {r.dryRun ? 'dry run' : 'applied'} · {r.triggeredBy.startsWith('user:') ? 'by an owner' : r.triggeredBy}
                          </span>
                          <span className="font-semibold">
                            {r.summary.guests} guests · {r.summary.reservations} reservations · {r.summary.notifications} messages · {r.summary.inboundEvents ?? 0} channel events
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            );
          }}
        </QueryState>
      </CardContent>
    </Card>
  );
}
