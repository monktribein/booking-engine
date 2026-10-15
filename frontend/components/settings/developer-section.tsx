'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, QueryState } from '@/components/ui/query-state';
import { API_SCOPES, WEBHOOK_EVENTS, developerApi, type WebhookDelivery, type WebhookEndpoint } from '@/lib/api/developer';
import { errorMessage } from '@/lib/utils/errors';

type Notice = { kind: 'success' | 'danger'; text: string };

const dateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

/** A secret shown exactly once. The backend keeps only a hash (API keys) or an encrypted copy (webhook secrets). */
function SecretReveal({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert
      variant="warning"
      title={`${label}: copy it now, it is shown only once`}
      message={value}
      onClose={onDismiss}
      action={{
        label: copied ? 'Copied' : 'Copy',
        onClick: () => {
          navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        },
      }}
      className="break-all font-mono"
    />
  );
}

function CheckboxGroup({ legend, options, selected, onChange }: { legend: string; options: readonly { value: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-semibold text-slate-700 dark:text-slate-300">{legend}</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              checked={selected.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ API keys

function ApiKeysCard({ onNotice }: { onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: developerApi.listKeys });
  const [form, setForm] = useState({ name: '', scopes: API_SCOPES.map((s) => s.value) as string[] });
  const [created, setCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => developerApi.createKey({ name: form.name.trim(), scopes: form.scopes }),
    onSuccess: async (k) => {
      setCreated(k.key);
      setForm({ ...form, name: '' });
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => developerApi.revokeKey(id),
    onSuccess: async () => {
      onNotice({ kind: 'success', text: 'API key revoked. It stopped working immediately.' });
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });

  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">API keys</CardTitle>
        <CardDescription>Credentials for the public API (/v1). Use them from your server only, never in a browser or app.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {created && (
          <div className="p-5 pb-0">
            <SecretReveal label="New API key" value={created} onDismiss={() => setCreated(null)} />
          </div>
        )}
        <QueryState query={keys} data={keys.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No API keys yet" hint="Create one below to let your website or partner call the API." />} skeletonRows={2}>
          {(list) => (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((k) => (
                <li key={k._id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">{k.name}</span>
                      <Badge variant={k.status === 'ACTIVE' ? 'success' : 'default'}>{k.status === 'ACTIVE' ? 'Active' : 'Revoked'}</Badge>
                    </div>
                    <div className="text-slate-500 font-mono">{k.keyPrefix}…</div>
                    <div className="text-slate-500">{k.scopes.join(', ')} • last used {dateTime(k.lastUsedAt)}</div>
                  </div>
                  {k.status === 'ACTIVE' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-rose-600"
                      aria-label={`Revoke ${k.name}`}
                      disabled={revoke.isPending}
                      onClick={() => {
                        if (window.confirm(`Revoke "${k.name}"? Anything using this key will stop working immediately.`)) revoke.mutate(k._id);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
        <form
          className="space-y-3 border-t border-slate-100 dark:border-slate-800 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!create.isPending) create.mutate();
          }}
        >
          <Input label="Key name *" required minLength={2} maxLength={100} placeholder="e.g. Tirvona marketplace" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <CheckboxGroup legend="Permissions" options={API_SCOPES} selected={form.scopes} onChange={(scopes) => setForm({ ...form, scopes })} />
          <Button type="submit" isLoading={create.isPending} disabled={create.isPending || form.scopes.length === 0 || form.name.trim().length < 2}>
            Create API key
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ webhooks

function DeliveriesDialog({ endpoint, onClose, onNotice }: { endpoint: WebhookEndpoint; onClose: () => void; onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const deliveries = useQuery({ queryKey: ['webhook-deliveries', endpoint._id], queryFn: () => developerApi.deliveries(endpoint._id), refetchInterval: 5000 });
  const redeliver = useMutation({
    mutationFn: (d: WebhookDelivery) => developerApi.redeliver(endpoint._id, d._id),
    onSuccess: async () => {
      onNotice({ kind: 'success', text: 'Delivery queued again.' });
      await queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', endpoint._id] });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const badge = (s: WebhookDelivery['status']) => (s === 'DELIVERED' ? 'success' : s === 'FAILED' ? 'danger' : 'warning');

  return (
    <Dialog isOpen onClose={onClose} title="Delivery history" description={endpoint.url} maxWidth="2xl">
      <QueryState query={deliveries} data={deliveries.data} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No deliveries yet" hint="Send a test event to see one here." />} skeletonRows={3}>
        {(d) => (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {d.items.map((x) => (
              <li key={x._id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{x.eventType}</span>
                    <Badge variant={badge(x.status)}>{x.status.toLowerCase()}</Badge>
                    <span className="text-slate-500">
                      {x.attempts} attempt{x.attempts === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="text-slate-500">
                    {dateTime(x.createdAt)}
                    {x.lastError ? ` • ${x.lastError}` : ''}
                  </div>
                </div>
                {x.status !== 'DELIVERED' && (
                  <Button variant="outline" size="sm" disabled={redeliver.isPending} onClick={() => redeliver.mutate(x)}>
                    Redeliver
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Dialog>
  );
}

function WebhooksCard({ onNotice }: { onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const endpoints = useQuery({ queryKey: ['webhook-endpoints'], queryFn: developerApi.listEndpoints });
  const [form, setForm] = useState({ url: '', events: ['reservation.created', 'reservation.confirmed', 'reservation.cancelled'] as string[] });
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [viewing, setViewing] = useState<WebhookEndpoint | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
  const fail = (e: unknown) => onNotice({ kind: 'danger', text: errorMessage(e) });

  const create = useMutation({
    mutationFn: () => developerApi.createEndpoint({ url: form.url.trim(), events: form.events }),
    onSuccess: async (e) => {
      setSecret({ label: 'Signing secret', value: e.secret });
      setForm({ ...form, url: '' });
      await refresh();
    },
    onError: fail,
  });
  const toggle = useMutation({ mutationFn: (e: WebhookEndpoint) => developerApi.setEndpointStatus(e._id, e.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'), onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => developerApi.deleteEndpoint(id), onSuccess: refresh, onError: fail });
  const rotate = useMutation({
    mutationFn: (id: string) => developerApi.rotateSecret(id),
    onSuccess: (e) => setSecret({ label: 'New signing secret', value: e.secret }),
    onError: fail,
  });
  const test = useMutation({
    mutationFn: (id: string) => developerApi.sendTest(id),
    onSuccess: () => onNotice({ kind: 'success', text: 'Test event queued. Open "Deliveries" to see the result.' }),
    onError: fail,
  });
  const busy = toggle.isPending || remove.isPending || rotate.isPending || test.isPending;

  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">Webhooks</CardTitle>
        <CardDescription>Tirvona POSTs signed JSON events (bookings, payments) to your HTTPS endpoint. Verify the Tirvona-Signature header with the signing secret.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {secret && (
          <div className="p-5 pb-0">
            <SecretReveal label={secret.label} value={secret.value} onDismiss={() => setSecret(null)} />
          </div>
        )}
        <QueryState query={endpoints} data={endpoints.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No webhook endpoints yet" hint="Add an HTTPS URL below to start receiving events." />} skeletonRows={2}>
          {(list) => (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((e) => (
                <li key={e._id} className="space-y-2 px-5 py-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-100 break-all">{e.url}</span>
                    <Badge variant={e.status === 'ACTIVE' ? 'success' : 'default'}>{e.status === 'ACTIVE' ? 'Active' : 'Disabled'}</Badge>
                  </div>
                  <div className="text-slate-500">{e.events.join(', ')}</div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" disabled={busy || e.status !== 'ACTIVE'} onClick={() => test.mutate(e._id)}>
                      Send test
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setViewing(e)}>
                      Deliveries
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => toggle.mutate(e)}>
                      {e.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm('Issue a new signing secret? The current one stops working immediately.')) rotate.mutate(e._id);
                      }}
                    >
                      Rotate secret
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-rose-600"
                      disabled={busy}
                      aria-label={`Delete ${e.url}`}
                      onClick={() => {
                        if (window.confirm('Delete this endpoint and its delivery history?')) remove.mutate(e._id);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
        <form
          className="space-y-3 border-t border-slate-100 dark:border-slate-800 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!create.isPending) create.mutate();
          }}
        >
          <Input label="Endpoint URL *" type="url" required placeholder="https://api.example.com/tirvona/webhooks" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <CheckboxGroup legend="Events" options={WEBHOOK_EVENTS} selected={form.events} onChange={(events) => setForm({ ...form, events })} />
          <Button type="submit" isLoading={create.isPending} disabled={create.isPending || form.events.length === 0 || !form.url.trim()}>
            Add endpoint
          </Button>
        </form>
      </CardContent>
      {viewing && <DeliveriesDialog endpoint={viewing} onClose={() => setViewing(null)} onNotice={onNotice} />}
    </Card>
  );
}

export function DeveloperSection() {
  const [notice, setNotice] = useState<Notice | null>(null);
  return (
    <div className="space-y-6">
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <ApiKeysCard onNotice={setNotice} />
      <WebhooksCard onNotice={setNotice} />
    </div>
  );
}
