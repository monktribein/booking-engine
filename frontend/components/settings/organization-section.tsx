'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { EmptyState, QueryState } from '@/components/ui/query-state';
import { integrationRequestsApi, organizationApi, teamApi, type IntegrationChannel, type IntegrationRequestStatus } from '@/lib/api/partners';
import { errorMessage } from '@/lib/utils/errors';
import { useProperty } from '@/lib/auth/property-context';
import { OrganizationStatus } from '@/types';

type Notice = { kind: 'success' | 'danger'; text: string };

const STATUS_BADGE: Record<OrganizationStatus, { text: string; variant: 'success' | 'warning' | 'danger' | 'default' }> = {
  [OrganizationStatus.ACTIVE]: { text: 'Approved', variant: 'success' },
  [OrganizationStatus.PENDING_APPROVAL]: { text: 'Waiting for approval', variant: 'warning' },
  [OrganizationStatus.REJECTED]: { text: 'Not approved', variant: 'danger' },
  [OrganizationStatus.SUSPENDED]: { text: 'Suspended', variant: 'danger' },
  [OrganizationStatus.ARCHIVED]: { text: 'Archived', variant: 'default' },
};

const CHANNELS: { value: IntegrationChannel; label: string }[] = [
  { value: 'BOOKING_COM', label: 'Booking.com' },
  { value: 'AIRBNB', label: 'Airbnb' },
  { value: 'AGODA', label: 'Agoda' },
  { value: 'OTHER', label: 'Another system' },
];
const channelLabel = (c: string) => CHANNELS.find((x) => x.value === c)?.label ?? c;

const REQUEST_BADGE: Record<IntegrationRequestStatus, 'default' | 'warning' | 'success' | 'danger'> = {
  REQUESTED: 'warning',
  IN_REVIEW: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  WITHDRAWN: 'default',
};

/** Organization profile, team (developer access) and integration requests. Owners only. */
export function OrganizationSection({ onNotice }: { onNotice: (n: Notice) => void }) {
  return (
    <div className="space-y-6">
      <ProfileCard onNotice={onNotice} />
      <TeamCard onNotice={onNotice} />
      <IntegrationsCard onNotice={onNotice} />
    </div>
  );
}

function ProfileCard({ onNotice }: { onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const org = useQuery({ queryKey: ['organization', 'me'], queryFn: organizationApi.me });
  const [name, setName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (n: string) => organizationApi.rename(n),
    onSuccess: async () => {
      setName(null);
      await queryClient.invalidateQueries({ queryKey: ['organization', 'me'] });
      onNotice({ kind: 'success', text: 'Organization name saved.' });
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">Organization</CardTitle>
        <CardDescription>Your business account with Tirvona. Properties, people and API access belong to it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        <QueryState query={org} data={org.data} skeletonRows={2}>
          {(o) => {
            const b = STATUS_BADGE[o.status];
            return (
              <>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <Badge variant={b.variant}>{b.text}</Badge>
                  <span className="text-slate-500">Registered {new Date(o.createdAt).toLocaleDateString()}</span>
                  {o.approvedAt && <span className="text-slate-500">Approved {new Date(o.approvedAt).toLocaleDateString()}</span>}
                </div>
                {o.status === OrganizationStatus.PENDING_APPROVAL && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">The Tirvona team reviews new organizations. Until then you can set up privately; publishing, API keys and integrations unlock after approval.</p>
                )}
                <form
                  className="flex items-end gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = (name ?? o.name).trim();
                    if (n.length >= 2 && n !== o.name && !save.isPending) save.mutate(n);
                  }}
                >
                  <div className="flex-1">
                    <Input label="Organization name" required minLength={2} maxLength={160} value={name ?? o.name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <Button type="submit" disabled={save.isPending || (name ?? o.name).trim() === o.name} isLoading={save.isPending}>
                    Save
                  </Button>
                </form>
              </>
            );
          }}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function TeamCard({ onNotice }: { onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: teamApi.members });
  const [invite, setInvite] = useState({ name: '', email: '' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members'] });
  const add = useMutation({
    mutationFn: () => teamApi.inviteDeveloper({ name: invite.name.trim(), email: invite.email.trim() }),
    onSuccess: async () => {
      setInvite({ name: '', email: '' });
      onNotice({ kind: 'success', text: 'Developer invited. They receive a link to set their password.' });
      await refresh();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => teamApi.removeDeveloper(id),
    onSuccess: async () => {
      onNotice({ kind: 'success', text: 'Access removed. Their sessions ended immediately.' });
      await refresh();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">People</CardTitle>
        <CardDescription>Property staff are managed per property under &quot;Users &amp; Staff&quot;. A developer manages API keys and webhooks and never sees bookings or guests.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <QueryState query={members} data={members.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No one yet" />} skeletonRows={2}>
          {(list) => (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((m) => (
                <li key={m._id} className="flex items-center justify-between px-5 py-3 text-xs">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{m.name}</div>
                    <div className="text-slate-500">{m.email} • {m.role.replace(/_/g, ' ').toLowerCase()} • {m.status.toLowerCase()}</div>
                  </div>
                  {m.role === 'DEVELOPER' && m.status !== 'DISABLED' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-rose-600"
                      aria-label={`Remove ${m.name}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Remove ${m.name}'s access? They are signed out immediately.`)) remove.mutate(m._id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
        <form
          className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end border-t border-slate-100 dark:border-slate-800 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!add.isPending) add.mutate();
          }}
        >
          <Input label="Developer name *" required value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
          <Input label="Developer email *" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
          <Button type="submit" isLoading={add.isPending} disabled={add.isPending}>
            Invite developer
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function IntegrationsCard({ onNotice }: { onNotice: (n: Notice) => void }) {
  const queryClient = useQueryClient();
  const { properties } = useProperty();
  const requests = useQuery({ queryKey: ['integration-requests'], queryFn: integrationRequestsApi.list });
  const [form, setForm] = useState<{ channel: IntegrationChannel; propertyId: string; note: string }>({ channel: 'BOOKING_COM', propertyId: '', note: '' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['integration-requests'] });
  const create = useMutation({
    mutationFn: () => integrationRequestsApi.create({ channel: form.channel, propertyId: form.propertyId || undefined, note: form.note.trim() || undefined }),
    onSuccess: async () => {
      setForm({ ...form, note: '' });
      onNotice({ kind: 'success', text: 'Request sent to the Tirvona team.' });
      await refresh();
    },
    onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const withdraw = useMutation({ mutationFn: (id: string) => integrationRequestsApi.withdraw(id), onSuccess: refresh, onError: (e) => onNotice({ kind: 'danger', text: errorMessage(e) }) });
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">Integration requests</CardTitle>
        <CardDescription>
          Ask the Tirvona team to enable a channel or system for your properties. A request is not a connection: Airbnb, Booking.com and Agoda connect only where Tirvona holds that channel&apos;s partner access, and you finish the connection yourself under Channel Manager.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <QueryState query={requests} data={requests.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No requests yet" />} skeletonRows={2}>
          {(list) => (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((r) => (
                <li key={r._id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">{channelLabel(r.channel)}</span>
                      <Badge variant={REQUEST_BADGE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Badge>
                    </div>
                    <div className="text-slate-500">
                      {properties.find((p) => p._id === r.propertyId)?.name ?? 'Whole organization'} • {new Date(r.createdAt).toLocaleDateString()}
                      {r.decisionNote ? ` • “${r.decisionNote}”` : ''}
                    </div>
                  </div>
                  {(r.status === 'REQUESTED' || r.status === 'IN_REVIEW') && (
                    <Button variant="outline" size="sm" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r._id)}>
                      Withdraw
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
        <form
          className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end border-t border-slate-100 dark:border-slate-800 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!create.isPending) create.mutate();
          }}
        >
          <Select label="Channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as IntegrationChannel })} options={CHANNELS} />
          <Select label="Property" value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value })} options={[{ value: '', label: 'Whole organization' }, ...properties.map((p) => ({ value: p._id, label: p.name }))]} />
          <Input label="Note" placeholder="Your listing or account" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <Button type="submit" isLoading={create.isPending} disabled={create.isPending}>
            Send request
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
