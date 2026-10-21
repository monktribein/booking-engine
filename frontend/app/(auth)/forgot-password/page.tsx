'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { authApi } from '@/lib/api/auth';
import { credentialErrorMessage } from '@/lib/utils/errors';
import { Input } from '@/components/ui/input';
import { ArrowLeft, CheckCircle2, ArrowRight } from 'lucide-react';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setIsLoading(true);
    setError(null);
    try {
      await authApi.forgotPassword(email);
      setSubmitted(true);
    } catch (err) {
      setError(credentialErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[#FAF9F5] text-slate-900 font-sans antialiased selection:bg-[#c1d8f0] selection:text-slate-900">
      {/* Back to Login Link */}
      <div className="w-full max-w-md mb-4">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Sign In
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
            Enter your email to receive a secure password reset link
          </p>
        </div>

        {/* Card */}
        <div className="rounded-3xl border border-stone-200/90 bg-white p-7 sm:p-8 shadow-xl shadow-stone-200/60 space-y-6">
          <div className="border-b border-stone-100 pb-4">
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Forgot Password
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              We will send instructions to your inbox
            </p>
          </div>

          {submitted ? (
            <div className="text-center py-4 space-y-3">
              <CheckCircle2 className="h-10 w-10 text-emerald-700 mx-auto" />
              <h4 className="font-bold text-sm text-slate-900">
                Password Reset Email Sent
              </h4>
              <p className="text-xs text-slate-500 max-w-xs mx-auto">
                If an account exists for <span className="font-semibold text-slate-800">{email}</span>, you will receive reset instructions shortly.
              </p>
              <div className="pt-3">
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center rounded-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] px-5 py-2 text-xs shadow-2xs transition"
                >
                  Return to Sign In
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div role="alert" className="p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">
                  {error}
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="reset-email" className="block text-xs font-semibold text-slate-700">
                  Email Address
                </label>
                <Input
                  id="reset-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="bg-white border-stone-300"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full inline-flex items-center justify-center rounded-full bg-[#c1d8f0] hover:bg-[#acc8e6] text-slate-900 font-semibold border border-[#a8c6e5] px-5 py-2.5 text-sm shadow-2xs transition-transform hover:-translate-y-0.5 cursor-pointer disabled:opacity-50"
                >
                  {isLoading ? 'Sending...' : 'Send Reset Link'} <ArrowRight className="h-4 w-4 ml-1.5" />
                </button>
              </div>
            </form>
          )}
        </div>
      </motion.div>
    </main>
  );
}
