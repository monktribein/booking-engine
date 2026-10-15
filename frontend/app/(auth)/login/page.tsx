'use client';

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { isDemoMode } from '@/lib/config';
import { credentialErrorMessage } from '@/lib/utils/errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Sparkles, ArrowRight } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  // Demo mode only pre-fills the seeded owner e-mail. The password is never pre-filled and
  // sign-in always goes through the real backend.
  const [email, setEmail] = useState(isDemoMode() ? 'owner@tirvona.demo' : '');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return; // ignore double submit
    submitting.current = true;
    setIsLoading(true);
    setError(null);
    try {
      await login({ email, password });
      router.push('/dashboard'); // stay locked while navigating: no second sign-in request
    } catch (err) {
      // Email is kept; only the password is cleared after a failed attempt.
      setPassword('');
      setError(credentialErrorMessage(err));
      submitting.current = false;
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950 font-sans">
      <div className="w-full max-w-md space-y-6">
        {/* Brand logo */}
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Tirvona PMS
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Sign in to access your property dashboard, bookings, and channel manager
          </p>
        </div>

        <Card className="shadow-lg border-slate-200/80 dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-bold">Sign In</CardTitle>
            <CardDescription>Enter your staff or owner credentials</CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-2">
            <form onSubmit={handleSubmit} className="space-y-4" noValidate={false}>
              {error && (
                <div role="alert" className="p-3 rounded-lg bg-rose-50 text-rose-700 text-xs border border-rose-200">
                  {error}
                </div>
              )}

              <Input
                label="Email Address"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />

              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <label htmlFor="login-password" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Password
                  </label>
                  <Link href="/forgot-password" className="text-xs text-indigo-600 hover:underline">
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="login-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>

              <Button type="submit" className="w-full font-semibold" isLoading={isLoading} disabled={isLoading}>
                Sign In to Dashboard <ArrowRight className="h-4 w-4 ml-1.5" />
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="text-center text-xs text-slate-500">
          Don&apos;t have an organization yet?{' '}
          <Link href="/register" className="font-semibold text-indigo-600 hover:underline">
            Register Property
          </Link>
        </div>
      </div>
    </div>
  );
}
