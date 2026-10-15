'use client';

import { Button } from '@/components/ui/button';

/** Shown when the property page cannot load (backend down, 5xx...). It never falls back to placeholder content. */
export default function StayError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
      <div className="max-w-md text-center space-y-4" role="alert">
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">We could not load this property</h1>
        <p className="text-sm text-slate-500">The booking service is temporarily unavailable. Please try again in a moment.</p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
