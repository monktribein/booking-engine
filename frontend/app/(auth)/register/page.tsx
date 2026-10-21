'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useAuth } from '@/lib/auth/auth-context';
import { credentialErrorMessage } from '@/lib/utils/errors';
import { Input } from '@/components/ui/input';
import { ArrowRight, ArrowLeft } from 'lucide-react';

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
        phone: phone.replace(/[\s-]/g, '') || undefined,
        password,
      });
      router.push('/dashboard');
    } catch (err) {
      setPassword('');
      setError(credentialErrorMessage(err));
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
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#c1d8f0] text-slate-900 border border-[#a8c6e5] transition-transform group-hover:scale-105">
              <span className="font-bold text-lg">T</span>
            </div>
            <span className="text-2xl font-bold tracking-tight text-slate-900">
              Tirvona
            </span>
          </Link>
          <p className="text-xs text-slate-500 font-normal">
            Create an organization account and start managing your rooms, bookings, and OTAs. New partners are reviewed before publishing; you can configure everything meanwhile.
          </p>
        </div>

        {/* Register Card */}
        <div className="rounded-3xl border border-stone-200/90 bg-white p-7 sm:p-8 space-y-6">
          <div className="border-b border-stone-100 pb-4">
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Register Property
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              Owner and property setup
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div role="alert" className="p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="reg-org" className="block text-xs font-semibold text-slate-700">
                Hotel / Resort / Organization Name *
              </label>
              <Input
                id="reg-org"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. Grand Horizon Boutique"
                className="bg-white border-stone-300"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="reg-name" className="block text-xs font-semibold text-slate-700">
                  Owner Name *
                </label>
                <Input
                  id="reg-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Anand Sharma"
                  className="bg-white border-stone-300"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="reg-phone" className="block text-xs font-semibold text-slate-700">
                  Phone Number
                </label>
                <Input
                  id="reg-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+919800000001"
                  className="bg-white border-stone-300"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="reg-email" className="block text-xs font-semibold text-slate-700">
                Email Address *
              </label>
              <Input
                id="reg-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@hotel.com"
                className="bg-white border-stone-300"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="reg-password" className="block text-xs font-semibold text-slate-700">
                Password (10+ chars, letter and digit) *
              </label>
              <Input
                id="reg-password"
                type="password"
                required
                minLength={10}
                maxLength={128}
                pattern="(?=.*[A-Za-z])(?=.*[0-9]).{10,128}"
                autoComplete="new-password"
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
                {isLoading ? 'Registering...' : 'Complete Registration'} <ArrowRight className="h-4 w-4 ml-1.5" />
              </button>
            </div>
          </form>
        </div>

        {/* Footer info */}
        <div className="text-center text-xs text-slate-500">
          Already registered?{' '}
          <Link href="/login" className="font-semibold text-slate-900 hover:underline">
            Sign In
          </Link>
        </div>
      </motion.div>
    </main>
  );
}
