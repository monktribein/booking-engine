'use client';

import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { authApi } from '@/lib/api/auth';
import { useAuth } from '@/lib/auth/auth-context';
import { describeError } from '@/lib/utils/errors';

type Notice = { kind: 'success' | 'danger'; text: string };
const E164 = /^\+[1-9]\d{6,14}$/;
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{10,128}$/;

function ProfileForm({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [phoneError, setPhoneError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: () => authApi.updateProfile({ name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) }),
    onSuccess: async () => {
      await refreshUser();
      onNotice({ kind: 'success', text: 'Profile saved.' });
    },
    onError: (e) => onNotice({ kind: 'danger', text: describeError(e).message }),
  });

  const changed = name.trim() !== (user?.name ?? '') || phone.trim() !== (user?.phone ?? '');
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">Your details</CardTitle>
        <CardDescription>Your name and phone number. Your sign-in e-mail and role can only be changed by an administrator.</CardDescription>
      </CardHeader>
      <CardContent className="p-5">
        <form
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (phone.trim() && !E164.test(phone.trim())) return setPhoneError('Use the international format, for example +919811111111');
            setPhoneError(undefined);
            if (!save.isPending) save.mutate();
          }}
        >
          <Input label="Name *" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Phone" type="tel" placeholder="+919811111111" value={phone} error={phoneError} onChange={(e) => setPhone(e.target.value)} />
          <Input label="E-mail" value={user?.email ?? ''} readOnly disabled />
          <Input label="Role" value={(user?.role ?? '').replace(/_/g, ' ').toLowerCase()} readOnly disabled className="capitalize" />
          <div className="sm:col-span-2">
            <Button type="submit" isLoading={save.isPending} disabled={save.isPending || !changed || !name.trim()}>
              Save changes
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordForm({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ next?: string; confirm?: string; current?: string }>({});

  const change = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setErrors({});
      onNotice({ kind: 'success', text: 'Password changed. Your other sign-ins were ended; this one stays active.' });
    },
    onError: (e) => {
      const d = describeError(e);
      if (d.fields?.currentPassword) setErrors({ current: 'The current password is incorrect.' });
      else onNotice({ kind: 'danger', text: d.message });
    },
  });

  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="text-base font-bold">Change password</CardTitle>
        <CardDescription>At least 10 characters, with a letter and a digit. Changing it signs you out everywhere else.</CardDescription>
      </CardHeader>
      <CardContent className="p-5">
        <form
          className="grid grid-cols-1 gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            const next_: typeof errors = {};
            if (!PASSWORD_RULE.test(next)) next_.next = 'Use 10 or more characters with a letter and a digit.';
            else if (next === current) next_.next = 'Choose a password different from the current one.';
            if (confirm !== next) next_.confirm = 'The two passwords do not match.';
            setErrors(next_);
            if (Object.keys(next_).length === 0 && !change.isPending) change.mutate();
          }}
        >
          <Input label="Current password *" type="password" autoComplete="current-password" required value={current} error={errors.current} onChange={(e) => setCurrent(e.target.value)} />
          <Input label="New password *" type="password" autoComplete="new-password" required value={next} error={errors.next} onChange={(e) => setNext(e.target.value)} />
          <Input label="Repeat new password *" type="password" autoComplete="new-password" required value={confirm} error={errors.confirm} onChange={(e) => setConfirm(e.target.value)} />
          <div className="sm:col-span-3">
            <Button type="submit" isLoading={change.isPending} disabled={change.isPending || !current || !next || !confirm}>
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ProfilePage() {
  const [notice, setNotice] = useState<Notice | null>(null);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Your profile</h1>
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Personal details and password for your Tirvona account.</p>
      </div>
      {notice && <Alert variant={notice.kind} message={notice.text} onClose={() => setNotice(null)} />}
      <ProfileForm onNotice={setNotice} />
      <PasswordForm onNotice={setNotice} />
    </div>
  );
}
