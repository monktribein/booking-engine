'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * The API redirects here after a channel's OAuth consent screen
 * (APP_URL/properties/:id/channels?connected=CODE). Forward to the dashboard channel page.
 */
function Redirect() {
  const router = useRouter();
  const params = useSearchParams();
  const connected = params.get('connected');
  useEffect(() => {
    router.replace(connected ? `/dashboard/channels/${connected.toLowerCase().replace('_', '-')}?connected=${encodeURIComponent(connected)}` : '/dashboard/channels');
  }, [router, connected]);
  return <p className="p-6 text-sm text-slate-500">Returning to the channel manager…</p>;
}

export default function ChannelOAuthReturnPage() {
  return (
    <Suspense fallback={null}>
      <Redirect />
    </Suspense>
  );
}
