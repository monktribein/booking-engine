import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ErrorState, EmptyState, QueryState } from '@/components/ui/query-state';
import { ApiError } from '@/lib/api/client';
import { describeError, errorMessage } from '@/lib/utils/errors';
import { shouldRetry } from '@/lib/query-provider';

describe('describeError distinguishes the failure kinds', () => {
  const cases: [string, ApiError, string, boolean][] = [
    ['network', new ApiError('x', 'NETWORK_ERROR', 0), 'network', true],
    ['expired session', new ApiError('x', 'TOKEN_EXPIRED', 401), 'auth', false],
    ['permission', new ApiError('Your role does not allow this action', 'FORBIDDEN', 403), 'permission', false],
    ['not found', new ApiError('gone', 'NOT_FOUND', 404), 'not-found', false],
    ['validation', new ApiError('Request validation failed', 'VALIDATION_ERROR', 400, { fields: { phone: ['phone must be E.164'] } }), 'validation', false],
    ['conflict', new ApiError('No rooms left', 'ROOM_NOT_AVAILABLE', 409), 'conflict', false],
    ['server', new ApiError('stack trace /usr/src/app/secret.js', 'INTERNAL_ERROR', 500), 'server', true],
    ['rate limit', new ApiError('x', 'THROTTLED', 429), 'server', true],
  ];
  it.each(cases)('%s', (_n, err, kind, retryable) => {
    const d = describeError(err);
    expect(d.kind).toBe(kind);
    expect(d.retryable).toBe(retryable);
  });

  it('never shows server internals for 5xx', () => {
    expect(describeError(new ApiError('stack trace /usr/src/app/secret.js', 'INTERNAL_ERROR', 500)).message).not.toMatch(/secret|usr/);
  });

  it('keeps the backend message for 4xx and surfaces the first invalid field', () => {
    expect(errorMessage(new ApiError('No rooms left', 'ROOM_NOT_AVAILABLE', 409))).toBe('No rooms left');
    expect(errorMessage(new ApiError('Request validation failed', 'VALIDATION_ERROR', 400, { fields: { phone: ['phone must be E.164'] } }))).toBe('phone: phone must be E.164');
  });

  it('non-API errors are generic', () => {
    expect(describeError(new Error('TypeError: x is undefined')).message).toBe('An unexpected error occurred. Please try again.');
  });
});

describe('query retry policy', () => {
  it('retries transient failures once, never 4xx', () => {
    expect(shouldRetry(0, new ApiError('x', 'NETWORK_ERROR', 0))).toBe(true);
    expect(shouldRetry(0, new ApiError('x', 'E', 503))).toBe(true);
    expect(shouldRetry(1, new ApiError('x', 'E', 503))).toBe(false);
    expect(shouldRetry(0, new ApiError('x', 'VALIDATION_ERROR', 400))).toBe(false);
    expect(shouldRetry(0, new ApiError('x', 'FORBIDDEN', 403))).toBe(false);
    expect(shouldRetry(0, new Error('bug'))).toBe(false);
  });
});

function Harness({ fn, empty }: { fn: () => Promise<string[]>; empty?: boolean }) {
  const query = useQuery({ queryKey: ['t'], queryFn: fn, retry: false });
  return (
    <QueryState query={query} data={query.data} isEmpty={(d) => d.length === 0} empty={empty ? <EmptyState title="Nothing yet" hint="Add one" /> : undefined}>
      {(items) => <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>}
    </QueryState>
  );
}
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('QueryState: loading, error, empty and data are distinct', () => {
  it('shows a busy skeleton while loading', () => {
    wrap(<Harness fn={() => new Promise(() => undefined)} />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('renders data', async () => {
    wrap(<Harness fn={async () => ['Room 101']} />);
    expect(await screen.findByText('Room 101')).toBeInTheDocument();
  });

  it('an EMPTY successful response shows the empty state, not an error', async () => {
    wrap(<Harness fn={async () => []} empty />);
    expect(await screen.findByText('Nothing yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a FAILED request shows an error alert and never the empty state', async () => {
    wrap(<Harness fn={async () => { throw new ApiError('boom', 'INTERNAL_ERROR', 500); }} empty />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/server error/i);
    expect(screen.queryByText('Nothing yet')).not.toBeInTheDocument();
  });

  it('offers Try again for retryable errors and calls refetch', async () => {
    const fn = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new ApiError('x', 'NETWORK_ERROR', 0)).mockResolvedValueOnce(['Recovered']);
    wrap(<Harness fn={fn} />);
    await userEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Recovered')).toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a permission error is not retryable and says so', async () => {
    wrap(<Harness fn={async () => { throw new ApiError('Your role does not allow this action', 'FORBIDDEN', 403); }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not allowed/i);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('an auth error links to sign-in instead of retrying', async () => {
    render(<ErrorState error={new ApiError('expired', 'TOKEN_EXPIRED', 401)} onRetry={() => undefined} />);
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});
