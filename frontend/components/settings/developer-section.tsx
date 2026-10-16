'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, QueryState } from '@/components/ui/query-state';
import { API_SCOPES, DEFAULT_SCOPES, WEBHOOK_EVENTS, developerApi, type ApiKey, type WebhookDelivery, type WebhookEndpoint } from '@/lib/api/developer';
import { errorMessage } from '@/lib/utils/errors';

type Notice = { kind: 'success' | 'danger'; text: string };

const dateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

/** The API origin the browser build was configured for. */
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000').replace(/\/+$/, '');

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

function CheckboxGroup({ legend, options, selected, onChange, flag }: { legend: string; options: readonly { value: string; label: string; sensitive?: boolean }[]; selected: string[]; onChange: (v: string[]) => void; flag?: string }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-semibold text-slate-700 dark:text-slate-300">{legend}</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {options.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              checked={selected.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
            />
            <span>
              {o.label}
              {o.sensitive && flag && <span className="ml-1.5 rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">{flag}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ getting started

const CURL_SAMPLE = `# 1. List your properties
curl ${API_BASE}/v1/properties \\
  -H "Authorization: Bearer tvk_YOUR_KEY"

# 2. Search availability (dates are YYYY-MM-DD)
curl "${API_BASE}/v1/properties/YOUR-SLUG/availability?checkIn=2026-12-05&checkOut=2026-12-07&adults=2" \\
  -H "Authorization: Bearer tvk_YOUR_KEY"

# 3. Create a booking. Idempotency-Key is required: retry with the same key and it never books twice.
curl -X POST ${API_BASE}/v1/reservations \\
  -H "Authorization: Bearer tvk_YOUR_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{"propertySlug":"YOUR-SLUG","checkIn":"2026-12-05","checkOut":"2026-12-07","adults":2,
       "rooms":[{"roomTypeId":"ROOM_TYPE_ID","ratePlanId":"RATE_PLAN_ID","quantity":1}],
       "guest":{"firstName":"Asha","lastName":"Rao","email":"asha@example.com","phone":"+919800000000"},
       "externalReference":"YOUR-OWN-BOOKING-ID"}'`;

const TS_SAMPLE = `import { TirvonaClient, constructWebhookEvent } from '@tirvona/sdk';

const tirvona = new TirvonaClient({ apiKey: process.env.TIRVONA_API_KEY!, baseUrl: '${API_BASE}' });

const [property] = await tirvona.listProperties();
const rooms = await tirvona.searchAvailability(property.slug, { checkIn: '2026-12-05', checkOut: '2026-12-07', adults: 2 });

// Safe to retry: the SDK sends an Idempotency-Key, and externalReference ties the booking to your own record.
const { reservation } = await tirvona.createReservation({
  propertySlug: property.slug, checkIn: '2026-12-05', checkOut: '2026-12-07', adults: 2,
  rooms: [{ roomTypeId: rooms[0].roomTypeId, ratePlanId: rooms[0].ratePlans[0].ratePlanId, quantity: 1 }],
  guest: { firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+919800000000' },
  externalReference: 'YOUR-OWN-BOOKING-ID',
});

// In your webhook handler (use the RAW request body, not re-serialized JSON):
const event = constructWebhookEvent(process.env.TIRVONA_WEBHOOK_SECRET!, req.headers['tirvona-signature'], rawBody);`;

function GettingStartedCard() {
  const [tab, setTab] = useState<'curl' | 'ts'>('curl');
  const sample = tab === 'curl' ? CURL_SAMPLE : TS_SAMPLE;
  const [copied, setCopied] = useState(false);
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">Connect your software</CardTitle>
        <CardDescription>Everything you need to call the Tirvona API from your server.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-5 text-xs">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-slate-700 dark:text-slate-300">API base URL</dt>
            <dd className="mt-0.5 break-all font-mono text-slate-900 dark:text-slate-100">{API_BASE}/v1</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-700 dark:text-slate-300">Authentication</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-400">
              Send <code className="font-mono">Authorization: Bearer tvk_…</code> on every request. Keys are secrets: use them on your server only, never in a browser or mobile app.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-700 dark:text-slate-300">Reference</dt>
            <dd className="mt-0.5 flex flex-wrap gap-x-4 gap-y-1">
              <a className="font-semibold text-indigo-600 hover:underline" href={`${API_BASE}/docs/v1`} target="_blank" rel="noreferrer">Interactive API reference</a>
              <a className="font-semibold text-indigo-600 hover:underline" href={`${API_BASE}/docs/v1/openapi.json`} target="_blank" rel="noreferrer">OpenAPI JSON</a>
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-700 dark:text-slate-300">TypeScript SDK</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-400">
              <code className="font-mono">@tirvona/sdk</code> lives in the Tirvona repository (<code className="font-mono">sdk/</code>): run <code className="font-mono">npm run build &amp;&amp; npm pack</code> there, then <code className="font-mono">npm install ./tirvona-sdk-0.2.0.tgz</code>. It is not on the public npm registry yet.
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-semibold text-slate-700 dark:text-slate-300">Webhooks</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-400">
              Events are POSTed as JSON with a <code className="font-mono">Tirvona-Signature</code> header (HMAC-SHA256 of <code className="font-mono">&lt;timestamp&gt;.&lt;raw body&gt;</code>). Delivery is at-least-once: deduplicate on <code className="font-mono">Tirvona-Event-Id</code>.
            </dd>
          </div>
        </dl>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex gap-1" role="tablist" aria-label="Sample language">
              {(['curl', 'ts'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-md px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${tab === t ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                  {t === 'curl' ? 'curl' : 'TypeScript'}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard?.writeText(sample).then(() => setCopied(true)).catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100"><code>{sample}</code></pre>
          <p className="mt-2 text-slate-500">These are samples with placeholders: nothing here has been sent. Replace <code className="font-mono">tvk_YOUR_KEY</code> with a key you create below.</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ health overview (real numbers only)

function OverviewCard() {
  const overview = useQuery({ queryKey: ['developer-overview'], queryFn: developerApi.overview, refetchInterval: 30_000 });
  const Stat = ({ label, value, tone }: { label: string; value: number | string; tone?: 'danger' | 'ok' }) => (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className={`text-lg font-bold ${tone === 'danger' && Number(value) > 0 ? 'text-rose-600' : 'text-slate-900 dark:text-slate-100'}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">Integration health</CardTitle>
        <CardDescription>Counted from your real API traffic and webhook deliveries. Nothing here is estimated.</CardDescription>
      </CardHeader>
      <CardContent className="p-5">
        <QueryState query={overview} data={overview.data} skeletonRows={2}>
          {(o) => {
            if (!o.apiKeys) return null; // not an overview payload
            const u = o.apiUsageLast7Days;
            const d = o.deliveriesLast24h;
            return (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Active API keys" value={o.apiKeys.active} />
                  <Stat label="API requests (7 days)" value={u.requests} />
                  <Stat label="Client errors (4xx)" value={u.clientErrors} />
                  <Stat label="Server errors (5xx)" value={u.serverErrors} tone="danger" />
                  <Stat label="Rate limited (429)" value={u.rateLimited} />
                  <Stat label="Webhook endpoints" value={o.webhookEndpoints.active} />
                  <Stat label="Delivered (24 h)" value={d.delivered} />
                  <Stat label="Failed (24 h)" value={d.failed} tone="danger" />
                </div>
                {o.endpointsWithProblems.length > 0 && (
                  <Alert
                    variant="warning"
                    title="Webhook endpoints that need attention"
                    message={o.endpointsWithProblems.map((p) => `${p.url}: ${p.failedLast24h} failed${p.lastError ? ` (${p.lastError})` : ''}`).join(' • ')}
                  />
                )}
              </div>
            );
          }}
        </QueryState>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ API keys

function UsageDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const usage = useQuery({ queryKey: ['api-key-usage', apiKey._id], queryFn: () => developerApi.keyUsage(apiKey._id) });
  return (
    <Dialog isOpen onClose={onClose} title={`Usage: ${apiKey.name}`} description="Requests per day, counted when each request finishes." maxWidth="lg">
      <QueryState query={usage} data={usage.data} isEmpty={(d) => d.days.length === 0} empty={<EmptyState title="No requests yet" hint="Usage appears after the key is first used." />} skeletonRows={3}>
        {(d) => {
          const max = Math.max(1, ...d.days.map((x) => x.requests));
          return (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 pr-3 font-semibold">Day</th>
                  <th className="py-1 pr-3 font-semibold">Requests</th>
                  <th className="py-1 pr-3 font-semibold">4xx</th>
                  <th className="py-1 pr-3 font-semibold">5xx</th>
                  <th className="py-1 font-semibold">429</th>
                </tr>
              </thead>
              <tbody>
                {d.days.map((x) => (
                  <tr key={x.day} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300">{x.day}</td>
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${Math.max(4, (x.requests / max) * 80)}px` }} aria-hidden="true" />
                        {x.requests}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3">{x.clientErrors}</td>
                    <td className={`py-1.5 pr-3 ${x.serverErrors ? 'text-rose-600 font-semibold' : ''}`}>{x.serverErrors}</td>
                    <td className="py-1.5">{x.rateLimited}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </QueryState>
    </Dialog>
  );
}

function RotateDialog({ apiKey, onClose, onRotated, onNotice }: { apiKey: ApiKey; onClose: () => void; onRotated: (key: string) => void; onNotice: (n: Notice) => void }) {
  const [grace, setGrace] = useState('0');
  const rotate = useMutation({
    mutationFn: () => developerApi.rotateKey(apiKey._id, Number(grace) || undefined),
    onSuccess: (k) => {
      onRotated(k.key);
      onClose();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  return (
    <Dialog isOpen onClose={onClose} title={`Rotate "${apiKey.name}"`} description="Creates a replacement key with the same permissions and restrictions." maxWidth="md">
      <div className="space-y-4 text-xs">
        <Select
          label="What happens to the current key"
          value={grace}
          onChange={(e) => setGrace(e.target.value)}
          options={[
            { value: '0', label: 'Stops working immediately' },
            { value: '1', label: 'Keeps working for 1 hour' },
            { value: '24', label: 'Keeps working for 24 hours' },
            { value: '72', label: 'Keeps working for 72 hours' },
          ]}
        />
        <p className="text-slate-500">Deploy the new key, then let the old one expire. The new secret is shown once.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => rotate.mutate()} isLoading={rotate.isPending} disabled={rotate.isPending}>Rotate key</Button>
        </div>
      </div>
    </Dialog>
  );
}

function ApiKeysCard({ onNotice }: { onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: developerApi.listKeys });
  const properties = useQuery({ queryKey: ['developer-properties'], queryFn: developerApi.properties });
  const [form, setForm] = useState({ name: '', scopes: DEFAULT_SCOPES, propertyIds: [] as string[], expiresAt: '' });
  const [created, setCreated] = useState<{ label: string; value: string } | null>(null);
  const [usageFor, setUsageFor] = useState<ApiKey | null>(null);
  const [rotateFor, setRotateFor] = useState<ApiKey | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['api-keys'] });

  const create = useMutation({
    mutationFn: () =>
      developerApi.createKey({
        name: form.name.trim(),
        scopes: form.scopes,
        ...(form.propertyIds.length ? { propertyIds: form.propertyIds } : {}),
        ...(form.expiresAt ? { expiresAt: new Date(`${form.expiresAt}T23:59:59`).toISOString() } : {}),
      }),
    onSuccess: async (k) => {
      setCreated({ label: 'New API key', value: k.key });
      setForm({ ...form, name: '' });
      await refresh();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => developerApi.revokeKey(id),
    onSuccess: async () => {
      onNotice({ kind: 'success', text: 'API key revoked. It stopped working immediately.' });
      await refresh();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const propertyOptions = (Array.isArray(properties.data) ? properties.data : []).map((p) => ({ value: p._id, label: p.name }));
  const scopeLabel = (v: string) => API_SCOPES.find((s) => s.value === v);

  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">API keys</CardTitle>
        <CardDescription>Credentials for the public API (/v1). Use them from your server only, never in a browser or app.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {created && (
          <div className="p-5 pb-0">
            <SecretReveal label={created.label} value={created.value} onDismiss={() => setCreated(null)} />
          </div>
        )}
        <QueryState query={keys} data={keys.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No API keys yet" hint="Create one below to let your website or partner call the API." />} skeletonRows={2}>
          {(list) => (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((k) => (
                <li key={k._id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">{k.name}</span>
                      <Badge variant={k.status === 'ACTIVE' ? 'success' : 'default'}>{k.status === 'ACTIVE' ? 'Active' : 'Revoked'}</Badge>
                      {k.environment && <Badge variant="outline">{k.environment}</Badge>}
                      {k.status === 'ACTIVE' && k.expiresAt && <Badge variant="warning">expires {new Date(k.expiresAt).toLocaleString()}</Badge>}
                    </div>
                    <div className="text-slate-500 font-mono">{k.keyPrefix}…</div>
                    <div className="text-slate-500">
                      {k.scopes.map((s) => (scopeLabel(s)?.sensitive ? `${s} (sensitive)` : s)).join(', ')}
                    </div>
                    <div className="text-slate-500">
                      created {dateTime(k.createdAt)} • last used {dateTime(k.lastUsedAt)}
                      {k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}
                      {k.propertyIds.length ? ` • limited to ${k.propertyIds.length} propert${k.propertyIds.length === 1 ? 'y' : 'ies'}` : ' • all properties'}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" aria-label={`Usage of ${k.name}`} onClick={() => setUsageFor(k)}>
                      Usage
                    </Button>
                    {k.status === 'ACTIVE' && (
                      <>
                        <Button variant="outline" size="sm" aria-label={`Rotate ${k.name}`} onClick={() => setRotateFor(k)}>
                          Rotate
                        </Button>
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
                      </>
                    )}
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
          <Input label="Key name *" required minLength={2} maxLength={100} placeholder="e.g. Tirvona marketplace" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <CheckboxGroup legend="Permissions (read-only by default)" options={API_SCOPES} selected={form.scopes} onChange={(scopes) => setForm({ ...form, scopes })} flag="sensitive" />
          {propertyOptions.length > 0 && <CheckboxGroup legend="Limit to these properties (none ticked = all properties)" options={propertyOptions} selected={form.propertyIds} onChange={(propertyIds) => setForm({ ...form, propertyIds })} />}
          <Input label="Expires on (optional)" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          <Button type="submit" isLoading={create.isPending} disabled={create.isPending || form.scopes.length === 0 || form.name.trim().length < 2}>
            Create API key
          </Button>
        </form>
      </CardContent>
      {usageFor && <UsageDialog apiKey={usageFor} onClose={() => setUsageFor(null)} />}
      {rotateFor && (
        <RotateDialog
          apiKey={rotateFor}
          onClose={() => setRotateFor(null)}
          onNotice={onNotice}
          onRotated={async (value) => {
            setCreated({ label: `Replacement for "${rotateFor.name}"`, value });
            await refresh();
          }}
        />
      )}
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
                    {x.lastStatusCode ? <span className="text-slate-500">HTTP {x.lastStatusCode}</span> : null}
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
  const [form, setForm] = useState({ url: '', events: ['reservation.created', 'reservation.confirmed', 'reservation.cancelled'] as string[], includeGuestDetails: false });
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [viewing, setViewing] = useState<WebhookEndpoint | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
  const fail = (e: unknown) => onNotice({ kind: 'danger', text: errorMessage(e) });

  const create = useMutation({
    mutationFn: () => developerApi.createEndpoint({ url: form.url.trim(), events: form.events, ...(form.includeGuestDetails ? { includeGuestDetails: true } : {}) }),
    onSuccess: async (e) => {
      setSecret({ label: 'Signing secret', value: e.secret });
      setForm({ ...form, url: '' });
      await refresh();
    },
    onError: fail,
  });
  const toggle = useMutation({ mutationFn: (e: WebhookEndpoint) => developerApi.setEndpointStatus(e._id, e.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'), onSuccess: refresh, onError: fail });
  const guests = useMutation({ mutationFn: (e: WebhookEndpoint) => developerApi.setGuestDetails(e._id, !e.includeGuestDetails), onSuccess: refresh, onError: fail });
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
  const busy = toggle.isPending || remove.isPending || rotate.isPending || test.isPending || guests.isPending;

  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">Webhooks</CardTitle>
        <CardDescription>Tirvona POSTs signed JSON events (bookings, payments, inventory) to your HTTPS endpoint. Verify the Tirvona-Signature header with the signing secret.</CardDescription>
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
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-100 break-all">{e.url}</span>
                    <Badge variant={e.status === 'ACTIVE' ? 'success' : 'default'}>{e.status === 'ACTIVE' ? 'Active' : 'Disabled'}</Badge>
                    <Badge variant={e.includeGuestDetails ? 'warning' : 'outline'}>{e.includeGuestDetails ? 'guest details included' : 'guest details hidden'}</Badge>
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
                        if (e.includeGuestDetails || window.confirm('Send guest e-mail, phone and special requests to this endpoint? Only turn this on if your system needs them.')) guests.mutate(e);
                      }}
                    >
                      {e.includeGuestDetails ? 'Hide guest details' : 'Include guest details'}
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
          <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600" checked={form.includeGuestDetails} onChange={(e) => setForm({ ...form, includeGuestDetails: e.target.checked })} />
            <span>Include guest e-mail, phone and special requests in the events. Off by default: events then carry the guest&apos;s first name and last initial only.</span>
          </label>
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
      <GettingStartedCard />
      <OverviewCard />
      <ApiKeysCard onNotice={setNotice} />
      <WebhooksCard onNotice={setNotice} />
    </div>
  );
}
