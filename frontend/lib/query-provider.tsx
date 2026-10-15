'use client';

import React, { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api/client';

/** Only transient failures (network, 5xx, 429) are worth a second attempt; a 4xx will fail the same way again. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof ApiError) return error.status === 0 || error.status >= 500 || error.status === 429;
  return false;
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            gcTime: 5 * 60 * 1000,
            retry: shouldRetry,
            refetchOnWindowFocus: false,
          },
          // Mutations (payments, bookings, check-in...) are never retried automatically.
          mutations: { retry: false },
        },
      })
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
