import React, { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { StaysSearchClient } from './search-client';

export const metadata: Metadata = {
  title: 'Find a stay | Tirvona',
  description: 'Search hotels and stays by destination, dates, guests, price and amenities, and book directly.',
};

export default function StaysSearchPage() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/stays" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 text-white shadow-md">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="text-base font-bold tracking-tight">Tirvona</span>
          </Link>
          <Link href="/booking/lookup" className="text-xs font-semibold text-slate-600 hover:text-indigo-600 dark:text-slate-300">
            Find existing booking
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Find your stay</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Live availability and prices, booked directly with the property.</p>
        </div>
        {/* useSearchParams needs a Suspense boundary so the page can still be prerendered */}
        <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
          <StaysSearchClient />
        </Suspense>
      </main>
    </div>
  );
}
