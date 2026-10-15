'use client';

import React from 'react';
import Link from 'next/link';
import { Alert } from './alert';
import { Skeleton } from './skeleton';
import { describeError } from '@/lib/utils/errors';

export interface QueryLike {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching?: boolean;
  refetch: () => unknown;
}

/** Error panel with a retry action only when retrying can help. Auth failures link to sign-in instead. */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const d = describeError(error);
  return (
    <div className={className}>
      <Alert
        variant={d.kind === 'permission' ? 'warning' : 'danger'}
        title={d.title}
        message={d.message}
        action={d.retryable && onRetry ? { label: 'Try again', onClick: onRetry } : undefined}
      />
      {d.kind === 'auth' && (
        <p className="mt-2 text-xs">
          <Link href="/login" className="font-semibold text-indigo-600 hover:underline">
            Sign in
          </Link>
        </p>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * Renders exactly one of: loading skeleton, error (with retry), empty state, or the data.
 * An empty *successful* response and a *failed* request are always visually distinct.
 */
export function QueryState<T>({
  query,
  data,
  isEmpty,
  empty,
  skeletonRows = 4,
  children,
}: {
  query: QueryLike;
  data: T | undefined;
  isEmpty?: (d: T) => boolean;
  empty?: React.ReactNode;
  skeletonRows?: number;
  children: (d: T) => React.ReactNode;
}) {
  if (query.isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        {Array.from({ length: skeletonRows }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (data === undefined) return null;
  if (isEmpty?.(data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return <>{children(data)}</>;
}

/** Shown on pages that need a property when the account has none or properties failed to load. */
export function NoPropertyState({ error, onRetry }: { error?: Error | null; onRetry?: () => void }) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  return <EmptyState title="No property yet" hint="Create a property in Settings to get started." />;
}
