'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, QueryState } from '@/components/ui/query-state';
import { adminApi, type AdminIntegrationRequest, type AdminPartner, type AdminProperty } from '@/lib/api/partners';
import { apiClient } from '@/lib/api/client';
import { errorMessage } from '@/lib/utils/errors';
import { useAuth } from '@/lib/auth/auth-context';
import { MarketplaceStatus, OrganizationStatus, UserRole } from '@/types';

type Notice = { kind: 'success' | 'danger'; text: string };
const dateOf = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

const PARTNER_BADGE: Record<OrganizationStatus, 'success' | 'warning' | 'danger' | 'default'> = {
  [OrganizationStatus.ACTIVE]: 'success',
  [OrganizationStatus.PENDING_APPROVAL]: 'warning',
  [OrganizationStatus.REJECTED]: 'danger',
  [OrganizationStatus.SUSPENDED]: 'danger',
  [OrganizationStatus.ARCHIVED]: 'default',
};
const MARKETPLACE_BADGE: Record<MarketplaceStatus, 'success' | 'warning' | 'danger' | 'default'> = {
  [MarketplaceStatus.NOT_LISTED]: 'default',
  [MarketplaceStatus.REQUESTED]: 'warning',
  [MarketplaceStatus.APPROVED]: 'success',
  [MarketplaceStatus.REJECTED]: 'danger',
  [MarketplaceStatus.SUSPENDED]: 'danger',
};
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase();

function useIsSuper() {
  const { user } = useAuth();
  return user?.role === UserRole.SUPER_ADMIN;
}

/** Asks for the reason of a decision that the partner will see (reject, suspend). */
function ReasonDialog({ title, description, confirmLabel, required, onConfirm, onClose }: { title: string; description: string; confirmLabel: string; required: boolean; onConfirm: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog isOpen onClose={onClose} title={title} description={description} maxWidth="md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!required || reason.trim()) onConfirm(reason.trim());
        }}
      >
        <label className="block space-y-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
          Reason {required ? '*' : '(optional)'}
          <textarea
            className="min-h-20 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={required && !reason.trim()}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function PanelHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{title}</h1>
      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  );
}

const Th = ({ children }: { children?: React.ReactNode }) => <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
const Td = ({ children, className = '' }: { children?: React.ReactNode; className?: string }) => <td className={`px-4 py-2.5 align-top text-xs ${className}`}>{children}</td>;

// ------------------------------------------------------------------ partners

export function PartnersPanel() {
  const queryClient = useQueryClient();
  const isSuper = useIsSuper();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [asking, setAsking] = useState<{ partner: AdminPartner; action: 'reject' | 'suspend' } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const partners = useQuery({ queryKey: ['admin', 'partners', status, q], queryFn: () => adminApi.partners({ status: status || undefined, q: q.trim() || undefined, limit: 50 }) });
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject' | 'suspend' | 'reactivate'; reason?: string }) => adminApi.partnerAction(v.id, v.action, v.reason),
    onSuccess: async (_d, v) => {
      setNotice({ kind: 'success', text: `Partner ${v.action === 'approve' ? 'approved' : v.action === 'reject' ? 'rejected' : v.action === 'suspend' ? 'suspended' : 'reactivated'}.` });
      setAsking(null);
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => {
      setAsking(null);
      setNotice({ kind: 'danger', text: errorMessage(e) });
    },
  });

  return (
    <>
      <PanelHeader title="Partners" description="Organizations that registered on Tirvona. New ones wait here for approval." />
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <Card className="shadow-xs">
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'All (waiting first)' }, ...Object.values(OrganizationStatus).map((s) => ({ value: s, label: label(s) }))]} />
            <Input label="Search" placeholder="Name or owner e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <QueryState query={partners} data={partners.data} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No partners match" />} skeletonRows={4}>
            {(d) => (
              <table className="w-full">
                <thead className="border-b border-slate-100 dark:border-slate-800">
                  <tr><Th>Organization</Th><Th>Owner</Th><Th>Status</Th><Th>Properties</Th><Th>API keys</Th><Th>Registered</Th><Th /></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {d.items.map((p) => (
                    <tr key={p._id}>
                      <Td><div className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</div></Td>
                      <Td>{p.ownerName}<div className="text-slate-500">{p.ownerEmail}</div></Td>
                      <Td>
                        <Badge variant={PARTNER_BADGE[p.status]}>{label(p.status)}</Badge>
                        {p.statusReason && <div className="mt-1 max-w-48 text-slate-500">{p.statusReason}</div>}
                      </Td>
                      <Td>{p.properties}</Td>
                      <Td>{p.activeApiKeys}</Td>
                      <Td>{dateOf(p.createdAt)}</Td>
                      <Td>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button variant="outline" size="sm" aria-label={`View ${p.name}`} onClick={() => setViewing(p._id)}>View</Button>
                          {(p.status === OrganizationStatus.PENDING_APPROVAL || p.status === OrganizationStatus.REJECTED) && (
                            <Button size="sm" aria-label={`Approve ${p.name}`} disabled={act.isPending} onClick={() => act.mutate({ id: p._id, action: 'approve' })}>Approve</Button>
                          )}
                          {p.status === OrganizationStatus.PENDING_APPROVAL && (
                            <Button variant="outline" size="sm" className="text-rose-600" aria-label={`Reject ${p.name}`} onClick={() => setAsking({ partner: p, action: 'reject' })}>Reject</Button>
                          )}
                          {isSuper && p.status === OrganizationStatus.ACTIVE && (
                            <Button variant="outline" size="sm" className="text-rose-600" aria-label={`Suspend ${p.name}`} onClick={() => setAsking({ partner: p, action: 'suspend' })}>Suspend</Button>
                          )}
                          {isSuper && p.status === OrganizationStatus.SUSPENDED && (
                            <Button size="sm" aria-label={`Reactivate ${p.name}`} disabled={act.isPending} onClick={() => act.mutate({ id: p._id, action: 'reactivate' })}>Reactivate</Button>
                          )}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryState>
        </CardContent>
      </Card>
      {asking && (
        <ReasonDialog
          title={`${asking.action === 'reject' ? 'Reject' : 'Suspend'} ${asking.partner.name}`}
          description={asking.action === 'reject' ? 'The partner sees this reason. They stay able to read it but cannot use the product.' : 'Their users are locked out, API keys stop working and public listings disappear. Existing bookings are not cancelled.'}
          confirmLabel={asking.action === 'reject' ? 'Reject partner' : 'Suspend partner'}
          required
          onClose={() => setAsking(null)}
          onConfirm={(reason) => act.mutate({ id: asking.partner._id, action: asking.action, reason })}
        />
      )}
      {viewing && <PartnerDetailDialog id={viewing} onClose={() => setViewing(null)} onNotice={setNotice} />}
    </>
  );
}

function PartnerDetailDialog({ id, onClose, onNotice }: { id: string; onClose: () => void; onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const isSuper = useIsSuper();
  const detail = useQuery({ queryKey: ['admin', 'partner', id], queryFn: () => adminApi.partner(id) });
  const [asking, setAsking] = useState<{ propertyId: string; name: string } | null>(null);
  const act = useMutation({
    mutationFn: (v: { propertyId: string; action: 'suspend' | 'reactivate'; reason?: string }) => adminApi.propertyAction(v.propertyId, v.action, v.reason),
    onSuccess: async () => {
      setAsking(null);
      onNotice({ kind: 'success', text: 'Property updated.' });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => {
      setAsking(null);
      onNotice({ kind: 'danger', text: errorMessage(e) });
    },
  });
  return (
    <Dialog isOpen onClose={onClose} title="Partner details" description="People and properties. Guests and bookings are not shown here." maxWidth="2xl">
      <QueryState query={detail} data={detail.data} skeletonRows={4}>
        {(p) => (
          <div className="space-y-5 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{p.name}</span>
              <Badge variant={PARTNER_BADGE[p.status]}>{label(p.status)}</Badge>
            </div>
            <section>
              <h3 className="mb-1.5 font-semibold text-slate-700 dark:text-slate-300">Properties</h3>
              {p.properties.length === 0 ? <p className="text-slate-500">None yet.</p> : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {p.properties.map((x) => (
                    <li key={x._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-slate-100">{x.name}</span> <span className="text-slate-500">{x.city}</span>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          <Badge variant={x.status === 'ACTIVE' ? 'success' : x.status === 'SUSPENDED' ? 'danger' : 'default'}>{label(x.status)}</Badge>
                          <Badge variant={x.directBookingEnabled ? 'info' : 'outline'}>{x.directBookingEnabled ? 'own page public' : 'own page private'}</Badge>
                          <Badge variant={MARKETPLACE_BADGE[x.marketplaceStatus]}>marketplace: {label(x.marketplaceStatus)}</Badge>
                        </div>
                        {x.suspendedReason && <div className="pt-1 text-slate-500">Suspended: {x.suspendedReason}</div>}
                      </div>
                      {isSuper && x.status !== 'SUSPENDED' && x.status !== 'ARCHIVED' && <Button variant="outline" size="sm" className="text-rose-600" aria-label={`Suspend property ${x.name}`} onClick={() => setAsking({ propertyId: x._id, name: x.name })}>Suspend property</Button>}
                      {isSuper && x.status === 'SUSPENDED' && <Button size="sm" aria-label={`Reactivate property ${x.name}`} onClick={() => act.mutate({ propertyId: x._id, action: 'reactivate' })}>Reactivate</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="mb-1.5 font-semibold text-slate-700 dark:text-slate-300">People</h3>
              <ul className="space-y-1 text-slate-600 dark:text-slate-400">
                {p.users.map((u) => <li key={u._id}>{u.name} • {u.email} • {label(u.role)} • {label(u.status)}</li>)}
              </ul>
            </section>
            {p.integrationRequests.length > 0 && (
              <section>
                <h3 className="mb-1.5 font-semibold text-slate-700 dark:text-slate-300">Integration requests</h3>
                <ul className="space-y-1 text-slate-600 dark:text-slate-400">
                  {p.integrationRequests.map((r) => <li key={r._id}>{label(r.channel)} • {label(r.status)} • {dateOf(r.createdAt)}</li>)}
                </ul>
              </section>
            )}
          </div>
        )}
      </QueryState>
      {asking && (
        <ReasonDialog
          title={`Suspend ${asking.name}`}
          description="Nobody can book it and the owner cannot lift this. Existing bookings are not cancelled."
          confirmLabel="Suspend property"
          required
          onClose={() => setAsking(null)}
          onConfirm={(reason) => act.mutate({ propertyId: asking.propertyId, action: 'suspend', reason })}
        />
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ marketplace

export function MarketplacePanel() {
  const queryClient = useQueryClient();
  const isSuper = useIsSuper();
  const [status, setStatus] = useState('REQUESTED');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [asking, setAsking] = useState<{ property: AdminProperty; action: 'reject' | 'suspend' } | null>(null);
  const props = useQuery({ queryKey: ['admin', 'properties', status], queryFn: () => adminApi.properties({ marketplaceStatus: status || undefined, limit: 50 }) });
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject' | 'suspend' | 'reinstate'; reason?: string }) => adminApi.marketplaceAction(v.id, v.action, v.reason),
    onSuccess: async () => {
      setAsking(null);
      setNotice({ kind: 'success', text: 'Listing updated.' });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => {
      setAsking(null);
      setNotice({ kind: 'danger', text: errorMessage(e) });
    },
  });
  return (
    <>
      <PanelHeader title="Marketplace" description="Properties whose owners consented to be listed publicly. Only approved ones appear in guest search." />
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <Card className="shadow-xs">
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="max-w-xs">
            <Select label="Listing status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'All' }, ...Object.values(MarketplaceStatus).map((s) => ({ value: s, label: label(s) }))]} />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <QueryState query={props} data={props.data} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="Nothing here" hint="No properties in this state." />} skeletonRows={4}>
            {(d) => (
              <table className="w-full">
                <thead className="border-b border-slate-100 dark:border-slate-800">
                  <tr><Th>Property</Th><Th>Organization</Th><Th>Status</Th><Th>Consent</Th><Th /></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {d.items.map((p) => (
                    <tr key={p._id}>
                      <Td><div className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</div><div className="text-slate-500">{p.city}, {p.state}</div></Td>
                      <Td>{p.organizationName}</Td>
                      <Td>
                        <Badge variant={MARKETPLACE_BADGE[p.marketplaceStatus]}>{label(p.marketplaceStatus)}</Badge>
                        <div className="pt-1 text-slate-500">property {label(p.status)}</div>
                        {p.marketplaceNote && <div className="mt-1 max-w-48 text-slate-500">{p.marketplaceNote}</div>}
                      </Td>
                      <Td>{dateOf(p.marketplaceConsentAt)}</Td>
                      <Td>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {p.marketplaceStatus === MarketplaceStatus.REQUESTED && (
                            <>
                              <Button size="sm" aria-label={`Approve listing ${p.name}`} disabled={act.isPending} onClick={() => act.mutate({ id: p._id, action: 'approve' })}>Approve</Button>
                              <Button variant="outline" size="sm" className="text-rose-600" aria-label={`Reject listing ${p.name}`} onClick={() => setAsking({ property: p, action: 'reject' })}>Reject</Button>
                            </>
                          )}
                          {isSuper && p.marketplaceStatus === MarketplaceStatus.APPROVED && <Button variant="outline" size="sm" className="text-rose-600" aria-label={`Suspend listing ${p.name}`} onClick={() => setAsking({ property: p, action: 'suspend' })}>Suspend</Button>}
                          {isSuper && p.marketplaceStatus === MarketplaceStatus.SUSPENDED && <Button size="sm" aria-label={`Reinstate listing ${p.name}`} disabled={act.isPending} onClick={() => act.mutate({ id: p._id, action: 'reinstate' })}>Reinstate</Button>}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryState>
        </CardContent>
      </Card>
      {asking && (
        <ReasonDialog
          title={`${asking.action === 'reject' ? 'Reject' : 'Suspend'} the listing of ${asking.property.name}`}
          description="The owner sees this note, so say what to fix."
          confirmLabel={asking.action === 'reject' ? 'Reject listing' : 'Suspend listing'}
          required
          onClose={() => setAsking(null)}
          onConfirm={(reason) => act.mutate({ id: asking.property._id, action: asking.action, reason })}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ integration requests

export function IntegrationsPanel() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('REQUESTED');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [asking, setAsking] = useState<{ request: AdminIntegrationRequest; status: 'APPROVED' | 'REJECTED' } | null>(null);
  const requests = useQuery({ queryKey: ['admin', 'integration-requests', status], queryFn: () => adminApi.integrationRequests({ status: status || undefined, limit: 50 }) });
  const decide = useMutation({
    mutationFn: (v: { id: string; status: 'IN_REVIEW' | 'APPROVED' | 'REJECTED'; note?: string }) => adminApi.decideIntegration(v.id, v.status, v.note),
    onSuccess: async () => {
      setAsking(null);
      setNotice({ kind: 'success', text: 'Decision saved.' });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => {
      setAsking(null);
      setNotice({ kind: 'danger', text: errorMessage(e) });
    },
  });
  return (
    <>
      <PanelHeader title="Integration requests" description="Partners asking to connect a channel or system. A decision here is a record: it does not connect anything." />
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <Alert variant="info" message="Airbnb, Booking.com and Agoda connect only where Tirvona holds that channel's approved partner access. Approving a request tells the partner they may proceed; the connection itself is completed by the partner under Channel Manager and is verified there." />
      <Card className="shadow-xs">
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="max-w-xs">
            <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'All' }, ...['REQUESTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN'].map((s) => ({ value: s, label: label(s) }))]} />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <QueryState query={requests} data={requests.data} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No requests" />} skeletonRows={3}>
            {(d) => (
              <table className="w-full">
                <thead className="border-b border-slate-100 dark:border-slate-800">
                  <tr><Th>Organization</Th><Th>Channel</Th><Th>Scope</Th><Th>Status</Th><Th>Requested</Th><Th /></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {d.items.map((r) => (
                    <tr key={r._id}>
                      <Td><div className="font-semibold text-slate-900 dark:text-slate-100">{r.organizationName}</div>{r.note && <div className="max-w-56 text-slate-500">{r.note}</div>}</Td>
                      <Td>{label(r.channel)}</Td>
                      <Td>{r.propertyName ?? 'Whole organization'}</Td>
                      <Td><Badge variant={r.status === 'APPROVED' ? 'success' : r.status === 'REJECTED' ? 'danger' : 'warning'}>{label(r.status)}</Badge>{r.decisionNote && <div className="mt-1 max-w-48 text-slate-500">{r.decisionNote}</div>}</Td>
                      <Td>{dateOf(r.createdAt)}</Td>
                      <Td>
                        {(r.status === 'REQUESTED' || r.status === 'IN_REVIEW') && (
                          <div className="flex flex-wrap justify-end gap-1.5">
                            {r.status === 'REQUESTED' && <Button variant="outline" size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r._id, status: 'IN_REVIEW' })}>In review</Button>}
                            <Button size="sm" aria-label={`Approve request of ${r.organizationName}`} onClick={() => setAsking({ request: r, status: 'APPROVED' })}>Approve</Button>
                            <Button variant="outline" size="sm" className="text-rose-600" aria-label={`Reject request of ${r.organizationName}`} onClick={() => setAsking({ request: r, status: 'REJECTED' })}>Reject</Button>
                          </div>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryState>
        </CardContent>
      </Card>
      {asking && (
        <ReasonDialog
          title={`${asking.status === 'APPROVED' ? 'Approve' : 'Reject'} ${label(asking.request.channel)} for ${asking.request.organizationName}`}
          description="The partner sees this note."
          confirmLabel={asking.status === 'APPROVED' ? 'Approve' : 'Reject'}
          required={asking.status === 'REJECTED'}
          onClose={() => setAsking(null)}
          onConfirm={(note) => decide.mutate({ id: asking.request._id, status: asking.status, note: note || undefined })}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ operations

export function OperationsPanel() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const errors = useQuery({ queryKey: ['admin', 'sync-errors'], queryFn: adminApi.syncErrors, refetchInterval: 30_000 });
  const queues = useQuery({ queryKey: ['admin', 'queues'], queryFn: adminApi.queues, refetchInterval: 15_000 });
  const retry = useMutation({
    mutationFn: (v: { kind: 'sync-jobs' | 'webhook-events'; id: string }) => apiClient<unknown>(`/admin/${v.kind}/${v.id}/retry`, { method: 'POST' }),
    onSuccess: async () => {
      setNotice({ kind: 'success', text: 'Queued again.' });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  return (
    <>
      <PanelHeader title="Operations" description="Queues, failed synchronisations and failed webhooks across all partners. No guest details." />
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <Card className="shadow-xs">
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800"><CardTitle className="text-base font-bold">Queues</CardTitle></CardHeader>
        <CardContent className="p-5">
          <QueryState query={queues} data={queues.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No queues" />} skeletonRows={2}>
            {(list) => (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((q) => (
                  <div key={q.queue} className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{q.queue}</div>
                    <div className="mt-1 text-slate-500">waiting {q.counts.waiting ?? 0} • active {q.counts.active ?? 0} • delayed {q.counts.delayed ?? 0}</div>
                    <div className={(q.counts.failed ?? 0) > 0 ? 'font-semibold text-rose-600' : 'text-slate-500'}>failed {q.counts.failed ?? 0}</div>
                  </div>
                ))}
              </div>
            )}
          </QueryState>
        </CardContent>
      </Card>
      <Card className="shadow-xs">
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
          <CardTitle className="text-base font-bold">Failed or retrying synchronisations</CardTitle>
          <CardDescription>Channel pushes that did not go through. A failing channel never affects bookings.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <QueryState query={errors} data={errors.data} skeletonRows={3}>
            {(e) => (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {e.syncJobs.items.length === 0 && e.failedWebhooks.length === 0 ? <EmptyState title="Nothing is failing" hint="All synchronisations and webhooks are healthy." /> : null}
                {e.syncJobs.items.map((j) => (
                  <div key={j._id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <div><span className="font-semibold">{j.channel}</span> • {label(j.type)} • <Badge variant="danger">{label(j.status)}</Badge> • {j.attempts} attempts<div className="text-slate-500">{j.lastError}</div></div>
                    <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate({ kind: 'sync-jobs', id: j._id })}>Retry</Button>
                  </div>
                ))}
                {e.failedWebhooks.map((w) => (
                  <div key={w._id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <div><span className="font-semibold">{w.channel}</span> • inbound {w.eventType} • <Badge variant="danger">failed</Badge><div className="text-slate-500">{w.error}</div></div>
                    <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate({ kind: 'webhook-events', id: w._id })}>Reprocess</Button>
                  </div>
                ))}
              </div>
            )}
          </QueryState>
        </CardContent>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ audit log (super admin)

export function AuditPanel() {
  const [action, setAction] = useState('');
  const logs = useQuery({ queryKey: ['admin', 'audit', action], queryFn: () => adminApi.auditLogs({ action: action.trim() || undefined, limit: 50 }) });
  return (
    <>
      <PanelHeader title="Audit log" description="Every administrative decision and partner action, newest first. Append-only." />
      <Card className="shadow-xs">
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="max-w-xs"><Input label="Filter by action" placeholder="e.g. admin.partner_approve" value={action} onChange={(e) => setAction(e.target.value)} /></div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <QueryState query={logs} data={logs.data} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No entries" />} skeletonRows={4}>
            {(d) => (
              <table className="w-full">
                <thead className="border-b border-slate-100 dark:border-slate-800"><tr><Th>When</Th><Th>Action</Th><Th>Entity</Th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {d.items.map((l) => (
                    <tr key={l._id}>
                      <Td>{new Date(l.createdAt).toLocaleString()}</Td>
                      <Td><code className="font-mono">{l.action}</code></Td>
                      <Td>{l.entityType} <span className="font-mono text-slate-500">{l.entityId.slice(0, 8)}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryState>
        </CardContent>
      </Card>
    </>
  );
}
