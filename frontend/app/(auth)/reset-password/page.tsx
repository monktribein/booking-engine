'use client';

import React, { Suspense, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { authApi } from '@/lib/api/auth';
import { credentialErrorMessage } from '@/lib/utils/errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Sparkles, CheckCircle2 } from 'lucide-react';

/** Target of the link in the password-reset / staff-invite e-mail: APP_URL/reset-password?token=... */
function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lock.current) return;
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await authApi.resetPassword(token, password); // the server signs out every session of this user
      setDone(true);
    } catch (err) {
      setError(credentialErrorMessage(err)); // e.g. the link expired or was already used
      setPassword('');
      setConfirm('');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950 font-sans">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
            <Sparkles className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Set a new password</h1>
        </div>

        <Card className="shadow-lg border-slate-200/80 dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-bold">New password</CardTitle>
            <CardDescription>10-128 characters with at least one letter and one digit.</CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-2">
            {!token ? (
              <Alert variant="danger" title="Link incomplete" message="This reset link is missing its token. Request a new one." />
            ) : done ? (
              <div className="text-center py-4 space-y-3">
                <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" aria-hidden="true" />
                <h4 className="font-bold text-sm">Password updated</h4>
                <p className="text-xs text-slate-500">You have been signed out everywhere. Sign in with your new password.</p>
                <Link href="/login"><Button size="sm">Go to sign in</Button></Link>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                {error && <Alert variant="danger" message={error} />}
                <Input label="New password *" type="password" required minLength={10} maxLength={128} pattern="(?=.*[A-Za-z])(?=.*[0-9]).{10,128}" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <Input label="Confirm password *" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                <Button type="submit" className="w-full font-semibold" isLoading={busy} disabled={busy}>Update password</Button>
              </form>
            )}
          </CardContent>
        </Card>
        <div className="text-center text-xs text-slate-500">
          <Link href="/forgot-password" className="text-indigo-600 hover:underline">Request a new link</Link>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
