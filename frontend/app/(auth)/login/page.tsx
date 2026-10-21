'use client';

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useAuth } from '@/lib/auth/auth-context';
import { isDemoMode } from '@/lib/config';
import { credentialErrorMessage } from '@/lib/utils/errors';
import { Input } from '@/components/ui/input';
import { ArrowRight, ArrowLeft } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const { login, user } = useAuth();
  // Demo mode only pre-fills the seeded owner e-mail.
  const [email, setEmail] = useState(isDemoMode() ? 'owner@tirvona.demo' : '');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  React.useEffect(() => {
    if (user) {
      router.replace('/dashboard');
    }
  }, [user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setIsLoading(true);
    setError(null);
    try {
      await login({ email, password });
      router.push('/dashboard');
    } catch (err) {
      setPassword('');
      setError(credentialErrorMessage(err));
      submitting.current = false;
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[#FAF9F5] text-slate-900 font-sans antialiased selection:bg-[#c1d8f0] selection:text-slate-900">
      {/* Back to Home Link */}
      <div className="w-full max-w-md mb-4">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Tirvona
        </Link>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="w-full max-w-md space-y-6"
      >
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-2.5 group">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#c1d8f0] text-slate-900 border border-[#a8c6e5] shadow-2xs transition-transform group-hover:scale-105">
              <span className="font-bold text-lg">T</span>
            </div>
            <span className="text-2xl font-bold tracking-tight text-slate-900">
              Tirvona
            </span>
          </Link>
          <p className="text-xs text-slate-500 font-normal">
            Sign in to access your hotel PMS, calendar, and channel manager
          </p>
        </div>

        {/* Sign In Card */}
        <div className="rounded-3xl border border-stone-200/90 bg-white p-7 sm:p-8 shadow-xl shadow-stone-200/60 space-y-6">
          <div className="border-b border-stone-100 pb-4">
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Sign In
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              Enter your staff or owner credentials
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate={false}>
            {error && (
              <div role="alert" className="p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="login-email" className="block text-xs font-semibold text-slate-700">
                Email Address
              </label>
              <Input
                id="login-email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="bg-white border-stone-300"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label htmlFor="login-password" className="block text-xs font-semibold text-slate-700">
                  Password
                </label>
                <Link href="/forgot-password" className="text-xs text-slate-600 hover:text-slate-900 hover:underline">
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
                className="bg-white border-stone-300"
              />
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={isLoading}
                className="w-full inline-flex items-center justify-center rounded-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] px-5 py-2.5 text-sm shadow-2xs transition-transform hover:-translate-y-0.5 cursor-pointer disabled:opacity-50"
              >
                {isLoading ? 'Signing in...' : 'Sign In to Dashboard'} <ArrowRight className="h-4 w-4 ml-1.5" />
              </button>
            </div>
          </form>
        </div>

        {/* Footer info */}
        <div className="text-center text-xs text-slate-500">
          Don&apos;t have an organization yet?{' '}
          <Link href="/register" className="font-semibold text-slate-900 hover:underline">
            Register Property
          </Link>
        </div>
      </motion.div>
    </main>
  );
}
