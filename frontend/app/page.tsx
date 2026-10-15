import React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Sparkles,
  LayoutDashboard,
  Calendar,
  Radio,
  ShieldCheck,
  ArrowRight,
  ExternalLink,
  BedDouble,
  CreditCard,
  Building2,
  CheckCircle2,
} from 'lucide-react';

export default function RootHomePage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-600 selection:text-white">
      {/* Background glow effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl" />
        <div className="absolute top-1/3 -right-40 w-96 h-96 bg-violet-600/15 rounded-full blur-3xl" />
      </div>

      {/* Top Navbar */}
      <header className="relative z-20 border-b border-slate-800/80 bg-slate-950/70 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/20">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="text-lg font-bold tracking-tight">Tirvona</span>
          </div>

          <div className="flex items-center gap-3">
            <Link href="/stays/radha-ashram" target="_blank">
              <Button variant="ghost" size="sm" className="text-slate-300 hover:text-white">
                Guest Booking Engine <ExternalLink className="h-3.5 w-3.5 ml-1" />
              </Button>
            </Link>
            <Link href="/login">
              <Button size="sm" className="bg-indigo-600 hover:bg-indigo-500 font-semibold shadow-md">
                Sign In
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-24 space-y-16">
        <div className="text-center space-y-5 max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3.5 py-1 text-xs font-semibold text-indigo-300 backdrop-blur-xs">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Production Hospitality Monolith • NestJS API Ready
          </div>

          <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-tight sm:leading-none bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
            PMS, Booking Engine & Channel Manager
          </h1>

          <p className="text-sm sm:text-base text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Tirvona synchronizes availability counters, rates, and direct guest holds across Airbnb, Booking.com, Agoda, and your high-conversion direct booking engine.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Link href="/dashboard">
              <Button size="lg" className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 font-bold px-8 shadow-xl shadow-indigo-600/30">
                Launch Owner Dashboard <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </Link>
            <Link href="/stays/radha-ashram" target="_blank">
              <Button variant="outline" size="lg" className="w-full sm:w-auto border-slate-700 bg-slate-900/60 text-slate-200 hover:bg-slate-800">
                View Public Booking Engine <ExternalLink className="h-4 w-4 ml-2" />
              </Button>
            </Link>
          </div>
        </div>

        {/* Dual Experiences Display */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4">
          {/* Experience 1: PMS Dashboard */}
          <div className="relative rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900/90 to-slate-950 p-8 space-y-6 shadow-2xl hover:border-indigo-500/50 transition-all group">
            <div className="flex items-center justify-between">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                <LayoutDashboard className="h-6 w-6" />
              </div>
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-400 bg-indigo-950/60 border border-indigo-800 px-3 py-1 rounded-full">
                Experience 1
              </span>
            </div>

            <div className="space-y-2">
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
                Owner & Admin PMS Dashboard
              </h2>
              <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
                Full-featured hotel management suite: tape-chart PMS calendar, room housekeeping, date-based inventory restrictions, rate plans, guest CRM, and payments.
              </p>
            </div>

            <div className="space-y-2.5 pt-2 text-xs text-slate-300">
              {[
                'Interactive tape-chart calendar (Day / Week / Month)',
                'Atomic inventory counters with zero double-selling',
                'Official OTA channel connections & markup formulas',
                'Staff role-based access control (RBAC)',
              ].map((feat, i) => (
                <div key={i} className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>{feat}</span>
                </div>
              ))}
            </div>

            <div className="pt-4">
              <Link href="/dashboard" className="block">
                <Button className="w-full bg-slate-800 hover:bg-slate-700 text-white font-semibold">
                  Open PMS Dashboard →
                </Button>
              </Link>
            </div>
          </div>

          {/* Experience 2: Public Booking Engine */}
          <div className="relative rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900/90 to-slate-950 p-8 space-y-6 shadow-2xl hover:border-emerald-500/50 transition-all group">
            <div className="flex items-center justify-between">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <Building2 className="h-6 w-6" />
              </div>
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 bg-emerald-950/60 border border-emerald-800 px-3 py-1 rounded-full">
                Experience 2
              </span>
            </div>

            <div className="space-y-2">
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
                Guest Public Booking Engine
              </h2>
              <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
                SEO-optimized, server-rendered direct booking site for guests with Open Graph and Schema.org rich snippets. Instant room holds, pricing calculator, and vouchers.
              </p>
            </div>

            <div className="space-y-2.5 pt-2 text-xs text-slate-300">
              {[
                'Server-rendered metadata, Open Graph & schema.org',
                'Real-time date availability & promo code discount engine',
                'Streamlined 5-step checkout & payment screen',
                'Instant booking vouchers and guest self-service lookup',
              ].map((feat, i) => (
                <div key={i} className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>{feat}</span>
                </div>
              ))}
            </div>

            <div className="pt-4">
              <Link href="/stays/radha-ashram" target="_blank" className="block">
                <Button className="w-full bg-slate-800 hover:bg-slate-700 text-white font-semibold">
                  View Live Guest Engine ↗
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 py-8 text-center text-xs text-slate-600">
        Tirvona Hospitality Suite • Production Frontend Architecture
      </footer>
    </div>
  );
}
