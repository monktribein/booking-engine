'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { authApi } from '@/lib/api/auth';
import { credentialErrorMessage } from '@/lib/utils/errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Sparkles, ArrowLeft, CheckCircle2 } from 'lucide-react';

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
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950 font-sans">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Reset Password
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Enter your email to receive a secure password reset link
          </p>
        </div>

        <Card className="shadow-lg border-slate-200/80 dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-bold">Forgot Password</CardTitle>
            <CardDescription>We will send instructions to your inbox</CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-2">
            {submitted ? (
              <div className="text-center py-4 space-y-3">
                <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
                <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100">
                  Password Reset Email Sent
                </h4>
                <p className="text-xs text-slate-500">
                  If an account exists for {email}, you will receive a reset link shortly.
                </p>
                <Link href="/login">
                  <Button variant="outline" size="sm" className="mt-2">
                    Back to Sign In
                  </Button>
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div role="alert" className="p-3 rounded-lg bg-rose-50 text-rose-700 text-xs border border-rose-200">
                    {error}
                  </div>
                )}
                <Input
                  label="Email Address *"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />

                <Button type="submit" className="w-full font-semibold" isLoading={isLoading}>
                  Send Reset Link
                </Button>

                <div className="text-center pt-2">
                  <Link
                    href="/login"
                    className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1"
                  >
                    <ArrowLeft className="h-3 w-3" /> Back to Sign In
                  </Link>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
