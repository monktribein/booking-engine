'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { credentialErrorMessage } from '@/lib/utils/errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Sparkles, ArrowRight } from 'lucide-react';

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
  const [orgName, setOrgName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setIsLoading(true);
    setError(null);
    try {
      await register({
        organizationName: orgName,
        name,
        email,
        phone: phone.replace(/[s-]/g, '') || undefined, // backend expects E.164, e.g. +919800000001
        password,
      });
      router.push('/dashboard'); // stay locked while navigating
    } catch (err) {
      setPassword('');
      setError(credentialErrorMessage(err));
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
            Register Property on Tirvona
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Create an organization account and start managing your rooms, bookings, and OTAs.
          </p>
        </div>

        <Card className="shadow-lg border-slate-200/80 dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-bold">Organization Signup</CardTitle>
            <CardDescription>Owner registration</CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-2">
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div role="alert" className="p-3 rounded-lg bg-rose-50 text-rose-700 text-xs border border-rose-200">
                  {error}
                </div>
              )}

              <Input
                label="Hotel / Ashram / Organization Name *"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. Radha Ashram Hospitality"
              />

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Owner Name *"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Anand Sharma"
                />
                <Input
                  label="Phone Number"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+919800000001"
                />
              </div>

              <Input
                label="Email Address *"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@hotel.com"
              />

              <Input
                label="Password (10+ chars, a letter and a digit) *"
                type="password"
                required
                minLength={10}
                maxLength={128}
                pattern="(?=.*[A-Za-z])(?=.*[0-9]).{10,128}"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />

              <Button type="submit" className="w-full font-semibold" isLoading={isLoading}>
                Complete Registration <ArrowRight className="h-4 w-4 ml-1.5" />
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="text-center text-xs text-slate-500">
          Already registered?{' '}
          <Link href="/login" className="font-semibold text-indigo-600 hover:underline">
            Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
