'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, QueryState } from '@/components/ui/query-state';
import { providerAdminApi, type AdminProvider, type AdminProviderVersion, type DryRunOutcome, type ValidationOutcome } from '@/lib/api/providers';
import { useAuth } from '@/lib/auth/auth-context';
import { errorMessage } from '@/lib/utils/errors';
import { UserRole } from '@/types';

type Notice = { kind: 'success' | 'danger'; text: string };
const dateOf = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');
const STATUS_BADGE: Record<string, 'success' | 'warning' | 'danger' | 'default' | 'info'> = { ACTIVE: 'success', DRAFT: 'warning', DISABLED: 'danger', VALIDATED: 'info', PUBLISHED: 'success', RETIRED: 'default' };

/** A small valid definition to start from. The full reference is in docs/CHANNEL_FRAMEWORK.md. */
export const STARTER_DEFINITION = {
  schemaVersion: 1,
  protocol: 'REST_JSON',
  environments: { production: { baseUrl: 'https://api.example-pms.com/v1' } },
  allowedHosts: ['api.example-pms.com'],
  auth: { type: 'API_KEY_HEADER', header: 'X-Api-Key' },
  capabilities: { listings: true, pushAvailability: true },
  operations: {
    healthCheck: { method: 'GET', path: '/ping' },
    listListings: { method: 'GET', path: '/properties', items: '$.data[*]', fields: { externalListingId: '$.id', name: '$.name' } },
    pushAvailability: {
      method: 'PUT',
      path: '/properties/{externalListingId}/availability',
      batchSize: 100,
      body: { items: { $each: 'updates', item: { room: '{item.externalRoomId}', date: '{item.date}', available: '{item.available}' } } },
    },
  },
};

export function ProvidersPanel() {
  const { user } = useAuth();
  const isSuper = user?.role === UserRole.SUPER_ADMIN;
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: providerAdminApi.list });
  const status = useMutation({
    mutationFn: (v: { id: string; status: 'ACTIVE' | 'DISABLED' }) => providerAdminApi.setStatus(v.id, v.status),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });

  if (openId) return <ProviderDetail id={openId} isSuper={isSuper} onBack={() => setOpenId(null)} />;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Providers</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Integrations defined as data. A published version is immutable; connections keep using the version they were made with.</p>
        </div>
        {isSuper && <Button size="sm" onClick={() => setCreating(true)}>New provider</Button>}
      </div>
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <Card className="shadow-xs">
        <CardContent className="overflow-x-auto p-0">
          <QueryState query={providers} data={providers.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No providers" />} skeletonRows={4}>
            {(rows) => (
              <table className="w-full text-xs">
                <thead className="border-b border-slate-100 dark:border-slate-800 text-left text-[11px] uppercase text-slate-500">
                  <tr><th className="px-4 py-2">Provider</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Published version</th><th className="px-4 py-2" /></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((p) => (
                    <tr key={p._id}>
                      <td className="px-4 py-2.5"><div className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</div><div className="font-mono text-slate-500">{p.code}</div></td>
                      <td className="px-4 py-2.5">{p.builtIn ? 'built in (code)' : p.protocol.replace('_', ' ').toLowerCase()}</td>
                      <td className="px-4 py-2.5"><Badge variant={STATUS_BADGE[p.status]}>{p.status.toLowerCase()}</Badge></td>
                      <td className="px-4 py-2.5">{p.currentVersionId ? 'yes' : p.builtIn ? '—' : 'none'}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          {!p.builtIn && <Button variant="outline" size="sm" aria-label={`Open ${p.name}`} onClick={() => setOpenId(p._id)}>Open</Button>}
                          {isSuper && !p.builtIn && p.status === 'ACTIVE' && <Button variant="outline" size="sm" className="text-rose-600" aria-label={`Disable ${p.name}`} onClick={() => status.mutate({ id: p._id, status: 'DISABLED' })}>Disable</Button>}
                          {isSuper && !p.builtIn && p.status === 'DISABLED' && <Button size="sm" aria-label={`Enable ${p.name}`} onClick={() => status.mutate({ id: p._id, status: 'ACTIVE' })}>Enable</Button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryState>
        </CardContent>
      </Card>
      {creating && <CreateProviderDialog onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); setOpenId(p._id); void queryClient.invalidateQueries({ queryKey: ['admin', 'providers'] }); }} />}
    </>
  );
}

function CreateProviderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: AdminProvider) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('PMS');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => providerAdminApi.create({ code, name, kind }), onSuccess: onCreated, onError: (e) => setError(errorMessage(e)) });
  return (
    <Dialog isOpen onClose={onClose} title="New provider" description="The code is permanent and appears as the source of every booking from this provider." maxWidth="md">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        {error && <Alert variant="danger" message={error} />}
        <Input label="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ACME_STAY" helperText="Capital letters, digits and underscores." />
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Stay" />
        <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: 'PMS', label: 'Property management system' }, { value: 'OTA', label: 'Online travel agency' }, { value: 'MARKETPLACE', label: 'Marketplace' }, { value: 'DIRECT', label: 'Direct booking site' }]} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" isLoading={create.isPending} disabled={!code || !name}>Create</Button></div>
      </form>
    </Dialog>
  );
}

function Validation({ v }: { v: ValidationOutcome | null }) {
  if (!v) return null;
  return (
    <div className="space-y-2" data-testid="validation">
      <Alert variant={v.ok ? 'success' : 'danger'} message={v.ok ? 'The definition is valid.' : `${v.errors.length} problem${v.errors.length === 1 ? '' : 's'} to fix.`} />
      {v.errors.length > 0 && <ul className="space-y-1 text-xs">{v.errors.map((e, i) => <li key={i}><code className="rounded bg-rose-50 px-1 text-rose-700">{e.path}</code> {e.message}</li>)}</ul>}
      {v.warnings.length > 0 && <ul className="space-y-1 text-xs text-amber-700">{v.warnings.map((e, i) => <li key={i}><code className="rounded bg-amber-50 px-1">{e.path}</code> {e.message}</li>)}</ul>}
    </div>
  );
}

function ProviderDetail({ id, isSuper, onBack }: { id: string; isSuper: boolean; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [text, setText] = useState(JSON.stringify(STARTER_DEFINITION, null, 2));
  const [editing, setEditing] = useState<AdminProviderVersion | null>(null);
  const [validation, setValidation] = useState<ValidationOutcome | null>(null);
  const [testing, setTesting] = useState<AdminProviderVersion | null>(null);
  const [diff, setDiff] = useState<{ path: string; from: unknown; to: unknown }[] | null>(null);
  const detail = useQuery({ queryKey: ['admin', 'provider', id], queryFn: () => providerAdminApi.get(id) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });
  const fail = (e: unknown) => setNotice({ kind: 'danger', text: errorMessage(e) });

  const parse = (): unknown | undefined => {
    try {
      return JSON.parse(text);
    } catch (e) {
      setNotice({ kind: 'danger', text: `This is not valid JSON: ${(e as Error).message}` });
      return undefined;
    }
  };
  const validate = useMutation({ mutationFn: (d: unknown) => providerAdminApi.validate(d), onSuccess: setValidation, onError: fail });
  const save = useMutation({
    mutationFn: (d: unknown) => (editing ? providerAdminApi.updateVersion(editing._id, d) : providerAdminApi.createVersion(id, d)),
    onSuccess: async (r) => {
      setValidation(r.validation);
      setEditing(null);
      setNotice({ kind: r.validation.ok ? 'success' : 'danger', text: r.validation.ok ? `Saved as version ${r.version.version} (validated). Test it, then publish.` : `Saved as a draft: version ${r.version.version} has problems.` });
      await refresh();
    },
    onError: fail,
  });
  const publish = useMutation({
    mutationFn: (v: AdminProviderVersion) => providerAdminApi.publish(v._id),
    onSuccess: async () => { setNotice({ kind: 'success', text: 'Published. New connections use this version.' }); await refresh(); },
    onError: fail,
  });
  const rollback = useMutation({
    mutationFn: (v: AdminProviderVersion) => providerAdminApi.rollback(id, v._id),
    onSuccess: async () => { setNotice({ kind: 'success', text: 'Rolled back: a copy of that version is now the published one.' }); await refresh(); },
    onError: fail,
  });
  const load = async (v: AdminProviderVersion, forEdit: boolean) => {
    try {
      const full = await providerAdminApi.version(v._id);
      setText(JSON.stringify(full.definition, null, 2));
      setEditing(forEdit ? v : null);
      setValidation(null);
    } catch (e) {
      fail(e);
    }
  };
  const compare = async (v: AdminProviderVersion, current: string) => {
    try {
      setDiff(await providerAdminApi.diff(current, v._id));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{detail.data?.provider.name ?? 'Provider'}</h1>
          <p className="font-mono text-xs text-slate-500">{detail.data?.provider.code}</p>
        </div>
      </div>
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <QueryState query={detail} data={detail.data} skeletonRows={3}>
        {({ provider, versions }) => (
          <>
            <Card className="shadow-xs">
              <CardHeader className="pb-2"><CardTitle className="text-base font-bold">Versions</CardTitle><CardDescription>Published versions cannot be changed. Edit a draft, or save a new version.</CardDescription></CardHeader>
              <CardContent className="overflow-x-auto p-0">
                {versions.length === 0 ? <p className="p-4 text-xs text-slate-500">No versions yet. Write a definition below and save it.</p> : (
                  <table className="w-full text-xs">
                    <thead className="border-b border-slate-100 dark:border-slate-800 text-left text-[11px] uppercase text-slate-500"><tr><th className="px-4 py-2">Version</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Checks</th><th className="px-4 py-2">Published</th><th className="px-4 py-2" /></tr></thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {versions.map((v) => {
                        const isCurrent = v._id === provider.currentVersionId;
                        const editable = v.status === 'DRAFT' || v.status === 'VALIDATED';
                        return (
                          <tr key={v._id}>
                            <td className="px-4 py-2.5 font-semibold">v{v.version}{isCurrent ? ' (current)' : ''}{v.notes ? <div className="font-normal text-slate-500">{v.notes}</div> : null}</td>
                            <td className="px-4 py-2.5"><Badge variant={STATUS_BADGE[v.status]}>{v.status.toLowerCase()}</Badge></td>
                            <td className="px-4 py-2.5">{v.validation?.ok ? 'valid' : v.validation ? `${v.validation.errors.length} problem(s)` : '—'}</td>
                            <td className="px-4 py-2.5">{dateOf(v.publishedAt)}</td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-wrap justify-end gap-1.5">
                                <Button variant="ghost" size="sm" aria-label={`View version ${v.version}`} onClick={() => void load(v, false)}>View</Button>
                                {provider.currentVersionId && !isCurrent && <Button variant="ghost" size="sm" aria-label={`Compare version ${v.version}`} onClick={() => void compare(v, provider.currentVersionId as string)}>Compare</Button>}
                                {isSuper && editable && <Button variant="outline" size="sm" aria-label={`Edit version ${v.version}`} onClick={() => void load(v, true)}>Edit</Button>}
                                {isSuper && v.status === 'VALIDATED' && <Button variant="outline" size="sm" aria-label={`Test version ${v.version}`} onClick={() => setTesting(v)}>Test</Button>}
                                {isSuper && v.status === 'VALIDATED' && <Button size="sm" aria-label={`Publish version ${v.version}`} isLoading={publish.isPending} onClick={() => publish.mutate(v)}>Publish</Button>}
                                {isSuper && v.status === 'RETIRED' && <Button variant="outline" size="sm" aria-label={`Roll back to version ${v.version}`} onClick={() => { if (window.confirm(`Publish a copy of version ${v.version} as the newest version?`)) rollback.mutate(v); }}>Roll back to this</Button>}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {diff && (
              <Card className="shadow-xs">
                <CardHeader className="pb-2 flex-row items-center justify-between"><CardTitle className="text-base font-bold">Differences from the current version</CardTitle><Button variant="ghost" size="sm" onClick={() => setDiff(null)}>Close</Button></CardHeader>
                <CardContent className="text-xs">
                  {diff.length === 0 ? 'No differences.' : <ul className="space-y-1">{diff.map((d) => <li key={d.path}><code>{d.path}</code>: <span className="text-rose-600">{JSON.stringify(d.from) ?? '(none)'}</span> → <span className="text-emerald-700">{JSON.stringify(d.to) ?? '(none)'}</span></li>)}</ul>}
                </CardContent>
              </Card>
            )}

            <Card className="shadow-xs">
              <CardHeader className="pb-2"><CardTitle className="text-base font-bold">{editing ? `Editing version ${editing.version}` : 'Definition'}</CardTitle><CardDescription>JSON only: hosts, paths, field paths and named transforms. There is no scripting. Credentials never go in here.</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                <textarea aria-label="Provider definition" className="h-80 w-full rounded-lg border border-slate-300 bg-white p-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" spellCheck={false} value={text} onChange={(e) => { setText(e.target.value); setValidation(null); }} />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" isLoading={validate.isPending} onClick={() => { const d = parse(); if (d !== undefined) validate.mutate(d); }}>Validate</Button>
                  {isSuper && <Button size="sm" isLoading={save.isPending} onClick={() => { const d = parse(); if (d !== undefined) save.mutate(d); }}>{editing ? `Save changes to version ${editing.version}` : 'Save as new version'}</Button>}
                  {editing && <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Stop editing</Button>}
                </div>
                <Validation v={validation} />
              </CardContent>
            </Card>
          </>
        )}
      </QueryState>
      {testing && <DryRunDialog version={testing} onClose={() => setTesting(null)} onDone={() => void refresh()} />}
    </>
  );
}

function DryRunDialog({ version, onClose, onDone }: { version: AdminProviderVersion; onClose: () => void; onDone: () => void }) {
  const [environment, setEnvironment] = useState<'production' | 'sandbox'>('sandbox');
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [result, setResult] = useState<DryRunOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => providerAdminApi.dryRun(version._id, { environment, credentials: Object.fromEntries(Object.entries(creds).filter(([, v]) => v)) }),
    onSuccess: (r) => { setResult(r); setError(null); onDone(); },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog isOpen onClose={onClose} title={`Test version ${version.version}`} description="Read-only checks against the provider (health, listings, rooms, rates, recent reservations). Nothing is sent or changed. The credentials are used for this test only and are not stored." maxWidth="lg">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        {error && <Alert variant="danger" message={error} />}
        <Select label="Environment" value={environment} onChange={(e) => setEnvironment(e.target.value as 'production' | 'sandbox')} options={[{ value: 'sandbox', label: 'Sandbox' }, { value: 'production', label: 'Live (read-only calls)' }]} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(['API_KEY', 'BEARER_TOKEN', 'BASIC_USERNAME', 'BASIC_PASSWORD'] as const).map((k) => (
            <Input key={k} label={k === 'API_KEY' ? 'API key' : k === 'BEARER_TOKEN' ? 'Access token' : k === 'BASIC_USERNAME' ? 'Username' : 'Password'} type="password" autoComplete="off" value={creds[k] ?? ''} onChange={(e) => setCreds({ ...creds, [k]: e.target.value })} />
          ))}
        </div>
        {result && (
          <div className="space-y-1 text-xs" data-testid="dry-run-result">
            <Alert variant={result.passed ? 'success' : 'danger'} message={result.passed ? 'All checks passed.' : 'Some checks failed.'} />
            <ul>{result.steps.map((s) => <li key={s.step}>{s.ok ? '✓' : '✗'} <span className="font-semibold">{s.step}</span>: {s.detail}</li>)}</ul>
          </div>
        )}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Close</Button><Button type="submit" isLoading={run.isPending}>Run test</Button></div>
      </form>
    </Dialog>
  );
}
