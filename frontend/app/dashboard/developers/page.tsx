'use client';

import React from 'react';
import { DeveloperSection } from '@/components/settings/developer-section';

/** API keys, webhooks and integration health for owners and developers. Developers (who have no property access) see only this. */
export default function DevelopersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Developers</h1>
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">Connect your own software to Tirvona: API keys, webhooks, documentation and integration health.</p>
      </div>
      <DeveloperSection />
    </div>
  );
}
