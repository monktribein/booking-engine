'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useProperty } from '@/lib/auth/property-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Alert } from '@/components/ui/alert';
import { EmptyState, NoPropertyState, QueryState } from '@/components/ui/query-state';
import { apiClient } from '@/lib/api/client';
import { propertiesApi } from '@/lib/api/properties';
import { errorMessage } from '@/lib/utils/errors';
import { Building2, Users, Trash2, KeyRound, Globe2, Briefcase } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { DeveloperSection } from '@/components/settings/developer-section';
import { OrganizationSection } from '@/components/settings/organization-section';
import { VisibilitySection } from '@/components/settings/visibility-section';
import type { Property } from '@/types';

interface Staff {
  userId: string;
  name: string;
  email: string;
  role: string;
  status: string;
}

const STAFF_ROLES = ['PROPERTY_MANAGER', 'STAFF', 'RECEPTION'];

export default function SettingsPage() {
  const { activeProperty, error: propertyError, reloadProperties, isLoading: propertyLoading } = useProperty();
  const propertyId = activeProperty?._id;
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // API keys and webhooks are organization-wide credentials: only owners manage them (the API enforces this too).
  const isOwner = user?.role === 'PROPERTY_OWNER';
  type Section = 'property' | 'visibility' | 'users' | 'organization' | 'developers';
  // Links such as /dashboard/settings?tab=visibility open that tab. This page only renders after the session is verified in the
  // browser, so reading the address here cannot differ from a server render.
  const [section, setSection] = useState<Section>(() => {
    const tab = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('tab');
    return tab === 'visibility' || tab === 'users' || tab === 'organization' || tab === 'developers' ? tab : 'property';
  });
  const [notice, setNotice] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  // Staff
  const staff = useQuery({
    queryKey: ['staff', propertyId],
    queryFn: () => apiClient<Staff[]>(`/properties/${propertyId}/users`),
    enabled: !!propertyId && section === 'users',
  });
  const [invite, setInvite] = useState({ email: '', name: '', role: 'RECEPTION' });
  const addStaff = useMutation({
    mutationFn: () =>
      apiClient<unknown>(`/properties/${propertyId}/users`, {
        method: 'POST',
        body: JSON.stringify({ email: invite.email.trim(), name: invite.name.trim(), role: invite.role }),
      }),
    onSuccess: async () => {
      setInvite({ email: '', name: '', role: 'RECEPTION' });
      setNotice({ kind: 'success', text: 'Staff member added. They receive a link to set their password.' });
      await queryClient.invalidateQueries({ queryKey: ['staff', propertyId] });
    },
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });
  const removeStaff = useMutation({
    mutationFn: (userId: string) => apiClient<unknown>(`/properties/${propertyId}/users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff', propertyId] }),
    onError: (e) => setNotice({ kind: 'danger', text: errorMessage(e) }),
  });

  if (!propertyId) {
    return propertyLoading ? null : <NoPropertyState error={propertyError} onRetry={() => void reloadProperties()} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Property Settings</h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Property details, check-in policy, tax and staff access.</p>
        </div>

        {/* Top Horizontal Navigation to save space and avoid blank sidebar */}
        <div className="flex items-center gap-1.5 overflow-x-auto bg-stone-100 dark:bg-slate-800 p-1 rounded-2xl w-fit" role="tablist" aria-label="Settings sections">
          {([
            ['property', 'Property Details', Building2],
            ['visibility', 'Visibility & Marketplace', Globe2],
            ['users', 'Users & Staff', Users],
            ...(isOwner ? [['organization', 'Organization', Briefcase] as const, ['developers', 'Developers', KeyRound] as const] : []),
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={section === id}
              onClick={() => setSection(id)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                section === id
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 border border-stone-200/60'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}

      <div className="max-w-5xl space-y-6">
        {section === 'property' && activeProperty && (
          <PropertyDetailsForm
            key={`${activeProperty._id}:${activeProperty.updatedAt}`}
            property={activeProperty}
            onSaved={async () => {
              setNotice({ kind: 'success', text: 'Property settings saved.' });
              await reloadProperties();
            }}
            onError={(text) => setNotice({ kind: 'danger', text })}
          />
        )}

        {section === 'visibility' && <VisibilitySection propertyId={propertyId} canManage={isOwner} onNotice={setNotice} />}

        {section === 'organization' && isOwner && <OrganizationSection onNotice={setNotice} />}

        {section === 'developers' && isOwner && <DeveloperSection />}

        {section === 'users' && (
          <div className="space-y-6">
            <Card className="rounded-3xl border border-stone-200/90 overflow-hidden bg-white dark:bg-slate-900">
              <CardHeader className="p-4 sm:p-5 border-b border-stone-100 dark:border-slate-800 bg-stone-50/60 dark:bg-slate-800/40">
                <CardTitle className="text-base font-bold text-slate-900 dark:text-slate-100">Team & Staff Access</CardTitle>
                <CardDescription className="text-xs text-slate-500">People with administrative access to this property</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <QueryState query={staff} data={staff.data} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No staff yet" />} skeletonRows={3}>
                  {(list) => (
                    <ul className="divide-y divide-stone-100 dark:divide-slate-800">
                      {list.map((s) => (
                        <li key={s.userId} className="flex items-center justify-between px-5 py-3.5 text-xs">
                          <div>
                            <div className="font-bold text-slate-900 dark:text-slate-100">{s.name}</div>
                            <div className="text-slate-500 mt-0.5">
                              {s.email} • <span className="font-semibold text-slate-700 dark:text-slate-300">{s.role.replace(/_/g, ' ')}</span> • {s.status}
                            </div>
                          </div>
                          {s.role !== 'PROPERTY_OWNER' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-rose-600 hover:text-rose-700 h-8 px-2.5 rounded-xl"
                              aria-label={`Remove ${s.name}`}
                              disabled={removeStaff.isPending}
                              onClick={() => {
                                if (window.confirm(`Remove ${s.name} from this property?`)) removeStaff.mutate(s.userId);
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
              </CardContent>
            </Card>

            <Card className="rounded-3xl border border-stone-200/90 overflow-hidden bg-white dark:bg-slate-900">
              <CardHeader className="p-4 sm:p-5 border-b border-stone-100 dark:border-slate-800 bg-stone-50/60 dark:bg-slate-800/40">
                <CardTitle className="text-base font-bold text-slate-900 dark:text-slate-100">Add New Staff Member</CardTitle>
                <CardDescription className="text-xs text-slate-500">Send an invitation to grant portal access</CardDescription>
              </CardHeader>
              <CardContent className="p-5 sm:p-6">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!addStaff.isPending) addStaff.mutate();
                  }}
                  className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
                >
                  <Input label="Full Name *" required value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
                  <Input label="Email Address *" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
                  <Select
                    label="Assigned Role"
                    value={invite.role}
                    onChange={(e) => setInvite({ ...invite, role: e.target.value })}
                    options={STAFF_ROLES.map((r) => ({ value: r, label: r.replace(/_/g, ' ') }))}
                  />
                  <button
                    type="submit"
                    disabled={addStaff.isPending}
                    className="h-10 rounded-xl bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-bold border border-[#a8c6e5] text-xs transition-colors cursor-pointer"
                  >
                    {addStaff.isPending ? 'Inviting...' : 'Add Staff'}
                  </button>
                </form>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function PropertyDetailsForm({
  property,
  onSaved,
  onError,
}: {
  property: Property;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState({
    name: property.name,
    description: property.description ?? '',
    address: property.address,
    city: property.city,
    state: property.state,
    checkInTime: property.checkInTime,
    checkOutTime: property.checkOutTime,
    taxPercent: property.taxPercent,
    bookingHorizonDays: property.bookingHorizonDays,
  });

  const save = useMutation({
    mutationFn: () =>
      propertiesApi.update(property._id, {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        address: form.address.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        checkInTime: form.checkInTime,
        checkOutTime: form.checkOutTime,
        taxPercent: Number(form.taxPercent),
        bookingHorizonDays: Number(form.bookingHorizonDays),
      }),
    onSuccess: onSaved,
    onError: (e) => onError(errorMessage(e)),
  });

  return (
    <Card className="rounded-3xl border border-stone-200/90 overflow-hidden bg-white dark:bg-slate-900">
      <CardHeader className="p-4 sm:p-5 border-b border-stone-100 dark:border-slate-800 bg-stone-50/60 dark:bg-slate-800/40">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <CardTitle className="text-base font-bold text-slate-900 dark:text-slate-100">Property Information & Policies</CardTitle>
            <CardDescription className="text-xs text-slate-500 mt-0.5">
              General identity, address location, and operational check-in rules.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-stone-200/80 px-2.5 py-1 rounded-xl">
              Currency: <strong>{property.currency}</strong>
            </span>
            <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-stone-200/80 px-2.5 py-1 rounded-xl">
              Timezone: <strong>{property.timezone}</strong>
            </span>
          </div>
        </div>
      </CardHeader>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!save.isPending) save.mutate();
        }}
      >
        <CardContent className="p-5 sm:p-6 space-y-6">
          {/* Identity Section */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Property Details</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <Input label="Property Name *" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Input label="City *" required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <div className="sm:col-span-2">
                <Input label="Street Address *" required value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <Input label="State *" required value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </div>

            <div>
              <Input
                label="Short Description"
                placeholder="Brief introduction displayed on booking engine..."
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
          </div>

          {/* Operational Policy Section */}
          <div className="pt-4 border-t border-stone-100 dark:border-slate-800 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Policies & Taxes</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
              <Input label="Check-in Time" type="time" value={form.checkInTime} onChange={(e) => setForm({ ...form, checkInTime: e.target.value })} />
              <Input label="Check-out Time" type="time" value={form.checkOutTime} onChange={(e) => setForm({ ...form, checkOutTime: e.target.value })} />
              <Input
                label="Tax Rate (%)"
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={form.taxPercent}
                onChange={(e) => setForm({ ...form, taxPercent: Number(e.target.value) })}
              />
              <Input
                label="Booking Horizon (days)"
                type="number"
                min={1}
                max={730}
                value={form.bookingHorizonDays}
                onChange={(e) => setForm({ ...form, bookingHorizonDays: Number(e.target.value) })}
              />
            </div>
          </div>
        </CardContent>

        <div className="p-4 sm:p-5 bg-stone-50/50 dark:bg-slate-800/20 border-t border-stone-100 dark:border-slate-800 flex justify-end">
          <button
            type="submit"
            disabled={save.isPending}
            className="inline-flex items-center justify-center rounded-xl bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-bold border border-[#a8c6e5] px-6 py-2.5 text-xs transition-all hover:-translate-y-0.5 cursor-pointer"
          >
            {save.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Card>
  );
}
