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
import { providersApi, type CatalogueEntry, type ConnectionDetail, type CredentialInput, type FeedInput, type ReconciliationIssue } from '@/lib/api/providers';
import { ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/utils/errors';
import { formatDate } from '@/lib/utils/dates';

const CREDENTIAL_LABELS: Record<string, string> = {
  API_KEY: 'API key',
  BEARER_TOKEN: 'Access token',
  BASIC_USERNAME: 'Username',
  BASIC_PASSWORD: 'Password',
  SIGNING_SECRET: 'Signing secret',
  WEBHOOK_SECRET: 'Webhook secret',
};
const CAPABILITY_LABELS: Record<string, string> = {
  listings: 'Import its listings',
  roomTypes: 'Import room types',
  ratePlans: 'Import rate plans',
  pullReservations: 'Receive reservations (polling)',
  getReservation: 'Look up a single reservation',
  pushAvailability: 'Send availability',
  pushRates: 'Send prices',
  pushRestrictions: 'Send restrictions',
  ackReservation: 'Acknowledge reservations',
  webhooks: 'Receive reservations instantly (webhooks)',
  polling: 'Check for reservations on a schedule',
};
const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS);
const ISSUE_LABELS: Record<string, string> = {
  MISSING_LOCAL: 'On the provider, not in Tirvona',
  MISSING_REMOTE: 'In Tirvona, unknown to the provider',
  STATUS_MISMATCH: 'Status differs',
  DATE_MISMATCH: 'Dates differ',
  UNMAPPED: 'Cannot be placed: map the listing',
  INGEST_FAILED: 'Could not be read',
};

const when = (iso: string | null | undefined) => (iso ? formatDate(iso, 'd MMM, h:mm a') : 'Never');
type Notice = { kind: 'success' | 'danger'; text: string };

interface Props {
  propertyId: string;
  channel: string;
  /** the channel's current status from the channel list */
  connected: boolean;
}

/**
 * Everything about a connection to a provider that is defined as data (a generic REST API or iCal calendars): what it can and cannot
 * do, the connection form, health, credentials (replace only: values are never shown), polling, webhook address and reconciliation.
 */
export function ConfiguredProviderPanel({ propertyId, channel, connected }: Props) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const catalogue = useQuery({ queryKey: ['provider-catalogue'], queryFn: providersApi.catalogue });
  const entry = catalogue.data?.find((p) => p.code === channel);
  const detail = useQuery({
    queryKey: ['provider-connection', propertyId, channel],
    queryFn: () => providersApi.connection(propertyId, channel),
    enabled: connected,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['provider-connection', propertyId, channel] }),
      queryClient.invalidateQueries({ queryKey: ['channels', propertyId] }),
      queryClient.invalidateQueries({ queryKey: ['channel-listings', propertyId, channel] }),
      queryClient.invalidateQueries({ queryKey: ['reconciliation', propertyId, channel] }),
    ]);
  };

  return (
    <div className="space-y-6">
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <QueryState query={catalogue} data={entry} isEmpty={(d) => !d} empty={<Alert variant="warning" title="Provider not available" message="This provider is not available to your organization." />}>
        {(p) => (
          <>
            <CapabilityCard entry={p} />
            {connected && detail.data ? (
              <ConnectionCard propertyId={propertyId} channel={channel} entry={p} detail={detail.data} onChanged={refresh} onNotice={setNotice} />
            ) : (
              <ConnectForm propertyId={propertyId} channel={channel} entry={p} onConnected={async () => { setNotice({ kind: 'success', text: `${p.name} is connected: the provider accepted the credentials.` }); await refresh(); }} onNotice={setNotice} />
            )}
            {connected && detail.data && <ReconciliationCard propertyId={propertyId} channel={channel} onNotice={setNotice} />}
          </>
        )}
      </QueryState>
    </div>
  );
}

function CapabilityCard({ entry }: { entry: CatalogueEntry }) {
  const can = entry.capabilities.filter((c) => c in CAPABILITY_LABELS);
  const cannot = ALL_CAPABILITIES.filter((c) => !can.includes(c));
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-bold">What {entry.name} supports</CardTitle>
        <CardDescription>
          {entry.protocol === 'ICAL' ? 'Calendar feeds only say which dates are taken. They carry no prices, guests or restrictions.' : `Connected through its API (${entry.authType ?? 'no authentication'}).`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
        <div>
          <div className="mb-1.5 font-semibold text-emerald-700 dark:text-emerald-400">Tirvona can</div>
          <ul className="space-y-1">{can.map((c) => <li key={c}>✓ {CAPABILITY_LABELS[c]}</li>)}</ul>
        </div>
        <div>
          <div className="mb-1.5 font-semibold text-slate-500">Not available with this provider</div>
          <ul className="space-y-1 text-slate-500">{cannot.map((c) => <li key={c}>– {CAPABILITY_LABELS[c]}</li>)}</ul>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectForm({ propertyId, channel, entry, onConnected, onNotice }: { propertyId: string; channel: string; entry: CatalogueEntry; onConnected: () => Promise<void>; onNotice: (n: Notice) => void }) {
  const isIcal = entry.protocol === 'ICAL';
  const kinds = entry.requiredCredentials.filter((k) => k in CREDENTIAL_LABELS);
  const [values, setValues] = useState<Record<string, string>>({});
  const [feeds, setFeeds] = useState<FeedInput[]>([{ name: '', url: '' }]);
  const [environment, setEnvironment] = useState<'production' | 'sandbox'>('production');
  const [poll, setPoll] = useState(String(entry.defaultPollIntervalSeconds ?? 900));
  const connect = useMutation({
    mutationFn: () =>
      providersApi.connect(propertyId, channel, {
        ...(isIcal ? { feeds: feeds.filter((f) => f.name.trim() && f.url.trim()) } : { credentials: values as CredentialInput, environment }),
        pollIntervalSeconds: entry.supportsPolling ? Number(poll) : undefined,
      }),
    onSuccess: onConnected,
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const ready = isIcal ? feeds.some((f) => f.name.trim() && f.url.trim()) : kinds.filter((k) => k !== 'WEBHOOK_SECRET').every((k) => values[k]?.trim());
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-bold">Connect {entry.name}</CardTitle>
        <CardDescription>The connection is made only after {entry.name} accepts what you enter here. Credentials are stored encrypted and are never shown again.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate();
          }}
        >
          {isIcal ? (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">Paste the calendar address (ICS link) the other platform gives you for each listing. Each address works like a password.</p>
              {feeds.map((f, i) => (
                <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2 items-end">
                  <Input label={`Calendar ${i + 1} name`} value={f.name} onChange={(e) => setFeeds(feeds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Airbnb – Deluxe room" />
                  <Input label={`Calendar ${i + 1} address`} type="password" autoComplete="off" value={f.url} onChange={(e) => setFeeds(feeds.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} placeholder="https://…/calendar.ics" />
                  {feeds.length > 1 && <Button type="button" variant="ghost" size="sm" aria-label={`Remove calendar ${i + 1}`} onClick={() => setFeeds(feeds.filter((_, j) => j !== i))}>Remove</Button>}
                </div>
              ))}
              {feeds.length < 10 && <Button type="button" variant="outline" size="sm" onClick={() => setFeeds([...feeds, { name: '', url: '' }])}>Add another calendar</Button>}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {kinds.map((k) => (
                <Input
                  key={k}
                  label={`${CREDENTIAL_LABELS[k]}${k === 'WEBHOOK_SECRET' ? ' (optional)' : ''}`}
                  type="password"
                  autoComplete="off"
                  value={values[k] ?? ''}
                  onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                  helperText={k === 'WEBHOOK_SECRET' ? 'Lets the provider send reservations to Tirvona instantly. Without it, Tirvona checks on a schedule.' : undefined}
                />
              ))}
              {entry.sandboxAvailable && (
                <Select label="Environment" value={environment} onChange={(e) => setEnvironment(e.target.value as 'production' | 'sandbox')} options={[{ value: 'production', label: 'Live' }, { value: 'sandbox', label: 'Sandbox (testing)' }]} />
              )}
            </div>
          )}
          {entry.supportsPolling && <Input label="Check for reservations every (seconds)" type="number" min={60} max={86400} value={poll} onChange={(e) => setPoll(e.target.value)} helperText="At least 60. Webhooks, when the provider supports them, arrive instantly." />}
          <Button type="submit" isLoading={connect.isPending} disabled={!ready || connect.isPending}>Test and connect</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ConnectionCard({ propertyId, channel, entry, detail, onChanged, onNotice }: { propertyId: string; channel: string; entry: CatalogueEntry; detail: ConnectionDetail; onChanged: () => Promise<void>; onNotice: (n: Notice) => void }) {
  const [replacing, setReplacing] = useState(false);
  const [interval, setIntervalValue] = useState(detail.polling.intervalSeconds ? String(detail.polling.intervalSeconds) : '');
  const test = useMutation({
    mutationFn: () => providersApi.test(propertyId, channel),
    onSuccess: async (r) => {
      onNotice({ kind: r.ok ? 'success' : 'danger', text: r.ok ? `Connection verified in ${r.latencyMs} ms.` : r.message });
      await onChanged();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const saveInterval = useMutation({
    mutationFn: () => providersApi.settings(propertyId, channel, { pollIntervalSeconds: interval === '' ? null : Number(interval) }),
    onSuccess: async () => {
      onNotice({ kind: 'success', text: interval === '' ? 'Scheduled checks are off.' : 'Polling interval saved.' });
      await onChanged();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const healthy = detail.status === 'CONNECTED' && !detail.lastError && !detail.polling.lastPollError;
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base font-bold">Connection</CardTitle>
            <CardDescription>
              {detail.provider?.name} • {detail.environment === 'sandbox' ? 'sandbox' : 'live'}
              {detail.provider?.version ? ` • definition v${detail.provider.version}` : ''}
            </CardDescription>
          </div>
          <Badge variant={healthy ? 'success' : detail.status === 'CONNECTED' ? 'warning' : 'danger'}>{healthy ? 'Healthy' : detail.status === 'CONNECTED' ? 'Needs attention' : detail.status.toLowerCase()}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
          <div className="flex justify-between"><dt className="text-slate-500">Last synchronisation</dt><dd className="font-semibold">{when(detail.lastSyncAt)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Last reservation check</dt><dd className="font-semibold">{when(detail.polling.lastPollAt)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Check interval</dt><dd className="font-semibold">{detail.polling.intervalSeconds ? `${detail.polling.intervalSeconds} s` : 'Off'}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Connected</dt><dd className="font-semibold">{when(detail.connectedAt)}</dd></div>
        </dl>

        {(detail.lastError || detail.polling.lastPollError) && (
          <Alert variant="danger" title="Last error" message={detail.polling.lastPollError ?? detail.lastError ?? ''} />
        )}

        {detail.feeds && (
          <div>
            <div className="mb-1 font-semibold text-slate-700 dark:text-slate-300">Calendars</div>
            <ul className="space-y-0.5 text-slate-600 dark:text-slate-400">{detail.feeds.map((f) => <li key={f.id}>{f.name} <span className="text-slate-500">({f.host})</span></li>)}</ul>
          </div>
        )}

        <div>
          <div className="mb-1 font-semibold text-slate-700 dark:text-slate-300">Stored credentials</div>
          <ul className="flex flex-wrap gap-2">
            {detail.credentials.map((c) => (
              <li key={c.kind}><Badge variant="outline">{CREDENTIAL_LABELS[c.kind] ?? (c.kind === 'FEED_URLS' ? 'Calendar addresses' : c.kind)} • set {when(c.rotatedAt ?? c.storedAt)}</Badge></li>
            ))}
          </ul>
          <p className="mt-1 text-slate-500">Values are never displayed. To change them, replace them: the new ones are verified first.</p>
        </div>

        {detail.webhook?.url && (
          <div>
            <div className="mb-1 font-semibold text-slate-700 dark:text-slate-300">Webhook address</div>
            <code className="block break-all rounded-md bg-slate-100 p-2 dark:bg-slate-800" data-testid="webhook-url">{detail.webhook.url}</code>
            <p className="mt-1 text-slate-500">Give this address to {entry.name}. Deliveries are checked against the signature in the <code>{detail.webhook.signatureHeader}</code> header.</p>
          </div>
        )}

        {entry.supportsPolling && (
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); saveInterval.mutate(); }}>
            <Input label="Check every (seconds, empty = off)" type="number" min={60} max={86400} value={interval} onChange={(e) => setIntervalValue(e.target.value)} className="max-w-48" />
            <Button type="submit" variant="outline" size="sm" isLoading={saveInterval.isPending}>Save</Button>
          </form>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" isLoading={test.isPending} onClick={() => test.mutate()}>Test connection</Button>
          <Button variant="outline" size="sm" onClick={() => setReplacing(!replacing)}>{replacing ? 'Cancel' : 'Replace credentials'}</Button>
        </div>
        {replacing && <ReplaceForm propertyId={propertyId} channel={channel} entry={entry} onDone={async () => { setReplacing(false); onNotice({ kind: 'success', text: 'New credentials verified and saved.' }); await onChanged(); }} onNotice={onNotice} />}
      </CardContent>
    </Card>
  );
}

function ReplaceForm({ propertyId, channel, entry, onDone, onNotice }: { propertyId: string; channel: string; entry: CatalogueEntry; onDone: () => Promise<void>; onNotice: (n: Notice) => void }) {
  const isIcal = entry.protocol === 'ICAL';
  const kinds = entry.requiredCredentials.filter((k) => k in CREDENTIAL_LABELS);
  const [values, setValues] = useState<Record<string, string>>({});
  const [feeds, setFeeds] = useState<FeedInput[]>([{ name: '', url: '' }]);
  const rotate = useMutation({
    mutationFn: () => providersApi.rotate(propertyId, channel, isIcal ? { feeds: feeds.filter((f) => f.name.trim() && f.url.trim()) } : { credentials: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())) as CredentialInput }),
    onSuccess: onDone,
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  return (
    <form className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700" onSubmit={(e) => { e.preventDefault(); rotate.mutate(); }}>
      <p className="text-slate-500">Enter only what changes. The previous credentials stay in place unless the new ones are accepted.</p>
      {isIcal ? (
        feeds.map((f, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Input label={`New calendar ${i + 1} name`} value={f.name} onChange={(e) => setFeeds(feeds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <Input label={`New calendar ${i + 1} address`} type="password" autoComplete="off" value={f.url} onChange={(e) => setFeeds(feeds.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
          </div>
        ))
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {kinds.map((k) => <Input key={k} label={`New ${CREDENTIAL_LABELS[k].toLowerCase()}`} type="password" autoComplete="off" value={values[k] ?? ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />)}
        </div>
      )}
      {isIcal && <Button type="button" variant="outline" size="sm" onClick={() => setFeeds([...feeds, { name: '', url: '' }])}>Add another calendar</Button>}
      <div><Button type="submit" size="sm" isLoading={rotate.isPending}>Verify and replace</Button></div>
    </form>
  );
}

function ReconciliationCard({ propertyId, channel, onNotice }: { propertyId: string; channel: string; onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['reconciliation', propertyId, channel], queryFn: () => providersApi.reconciliation(propertyId, channel) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['reconciliation', propertyId, channel] });
  const run = useMutation({
    mutationFn: () => providersApi.reconcile(propertyId, channel),
    onSuccess: async (r) => {
      onNotice({ kind: 'success', text: `Comparison finished: ${r.issueCount} difference${r.issueCount === 1 ? '' : 's'} found.` });
      await refresh();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const resolve = useMutation({
    mutationFn: (v: { issue: ReconciliationIssue; status: 'RESOLVED' | 'IGNORED' }) => providersApi.resolveIssue(propertyId, channel, v.issue._id, v.status, v.status === 'IGNORED' ? 'Reviewed and ignored by staff' : 'Resolved by staff'),
    onSuccess: refresh,
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base font-bold">Reconciliation</CardTitle>
            <CardDescription>Compares the provider with Tirvona. Missing bookings are imported; nothing is ever cancelled or changed automatically.</CardDescription>
          </div>
          <Button variant="outline" size="sm" isLoading={run.isPending} onClick={() => run.mutate()}>Compare now</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <QueryState query={q} data={q.data} skeletonRows={2}>
          {(d) => (
            <>
              <p className="text-slate-500">{d.runs[0] ? `Last comparison ${when(d.runs[0].startedAt)}: ${d.runs[0].status.toLowerCase()}${d.runs[0].error ? ` (${d.runs[0].error})` : ''}.` : 'Not compared yet.'}</p>
              {d.issues.length === 0 ? (
                <p className="text-emerald-700 dark:text-emerald-400">No open differences.</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {d.issues.map((i) => (
                    <li key={i._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div>
                        <Badge variant="warning">{ISSUE_LABELS[i.kind] ?? i.kind}</Badge> <span className="font-mono">{i.externalReservationId ?? ''}</span>
                        <div className="text-slate-500">{Object.entries(i.details).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' • ')}</div>
                      </div>
                      <div className="flex gap-1.5">
                        <Button variant="outline" size="sm" aria-label={`Resolve ${i.externalReservationId}`} onClick={() => resolve.mutate({ issue: i, status: 'RESOLVED' })}>Resolved</Button>
                        <Button variant="ghost" size="sm" aria-label={`Ignore ${i.externalReservationId}`} onClick={() => resolve.mutate({ issue: i, status: 'IGNORED' })}>Ignore</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}
