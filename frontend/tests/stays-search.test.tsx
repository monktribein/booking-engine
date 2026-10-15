import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fail, mockFetch, ok } from './helpers';

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => search,
}));

import { StaysSearchClient } from '@/app/stays/search-client';

const item = (over: Record<string, unknown> = {}) => ({
  slug: 'radha-ashram',
  name: 'Radha Ashram',
  description: 'Peaceful stay near the temple',
  city: 'Vrindavan',
  state: 'Uttar Pradesh',
  country: 'IN',
  currency: 'INR',
  image: { url: 'https://img.example.com/a.jpg', caption: 'Courtyard' },
  amenities: ['wifi', 'parking'],
  startingFromPrice: 350000,
  maxOccupancy: 3,
  ...over,
});
const page = (items: unknown[], total = items.length) => ({ items, page: 1, limit: 12, total });

function mount(params = '') {
  search = new URLSearchParams(params);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StaysSearchClient />
    </QueryClientProvider>,
  );
}
const dayFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const lastUrl = (m: ReturnType<typeof mockFetch>) => new URL(m.calls[m.calls.length - 1].url);

beforeEach(() => replace.mockClear());

describe('stays search page', () => {
  it('shows real results with the from-price and links to the property', async () => {
    const m = mockFetch(() => ok(page([item()])));
    mount();
    const card = await screen.findByRole('link', { name: /Radha Ashram/ });
    expect(card).toHaveAttribute('href', '/stays/radha-ashram');
    expect(within(card).getByText(/₹3,500/)).toBeInTheDocument();
    expect(within(card).getByText('Vrindavan, Uttar Pradesh')).toBeInTheDocument();
    expect(screen.getByText('1 stay found')).toBeInTheDocument();
    expect(lastUrl(m).pathname).toBe('/public/properties');
  });

  it('reads the search from the URL, sends it to the API and carries the dates to the property link', async () => {
    const m = mockFetch(() => ok(page([item({ nights: 2, availableFromNightly: 360000, availableFromTotal: 756000, availableRoomTypes: 1 })])));
    mount('q=vrindavan&checkIn=2026-11-05&checkOut=2026-11-07&adults=3&minPrice=100000&maxPrice=500000&amenities=wifi,pool&sort=price_asc');
    const card = await screen.findByRole('link', { name: /Radha Ashram/ });
    const u = lastUrl(m);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ q: 'vrindavan', checkIn: '2026-11-05', checkOut: '2026-11-07', adults: '3', minPrice: '100000', maxPrice: '500000', amenities: 'wifi,pool', sort: 'price_asc' });
    expect(card).toHaveAttribute('href', '/stays/radha-ashram?checkIn=2026-11-05&checkOut=2026-11-07&adults=3');
    expect(within(card).getByText(/₹3,600/)).toBeInTheDocument(); // the stay's price, not the list price
    expect(within(card).getByText(/₹7,560 total/)).toBeInTheDocument();
    expect(card).toHaveTextContent('for 2 nights, taxes incl.');
  });

  it('ignores a malformed URL instead of sending it', async () => {
    const m = mockFetch(() => ok(page([])));
    mount('checkIn=tomorrow&checkOut=2026-11-01&minPrice=abc&sort=random&adults=x');
    await screen.findByText('No stays match your search');
    expect(Object.fromEntries(lastUrl(m).searchParams)).toEqual({ limit: '12', page: '1' });
  });

  it('submitting writes the form to the URL, converting rupees to paise', async () => {
    mockFetch(() => ok(page([])));
    const user = userEvent.setup();
    mount();
    await screen.findByText('No stays match your search');
    await user.type(screen.getByLabelText('Where to?'), ' Goa ');
    await user.type(screen.getByLabelText('Check-in'), dayFromNow(10));
    await user.type(screen.getByLabelText('Check-out'), dayFromNow(12));
    await user.type(screen.getByLabelText(/Min price/), '1500');
    await user.type(screen.getByLabelText(/Max price/), '4000.50');
    await user.click(screen.getByLabelText('WiFi'));
    await user.click(screen.getByLabelText('Pool'));
    await user.click(screen.getByRole('button', { name: /search/i }));
    expect(replace).toHaveBeenCalledTimes(1);
    const url = new URL(replace.mock.calls[0][0] as string, 'http://x');
    expect(url.pathname).toBe('/stays');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'Goa', checkIn: dayFromNow(10), checkOut: dayFromNow(12), adults: '2', minPrice: '150000', maxPrice: '400050', amenities: 'wifi,pool' });
  });

  it('refuses inconsistent input without calling the API again', async () => {
    const m = mockFetch(() => ok(page([])));
    const user = userEvent.setup();
    mount();
    await screen.findByText('No stays match your search');
    const calls = m.calls.length;
    await user.type(screen.getByLabelText('Check-in'), dayFromNow(10));
    await user.click(screen.getByRole('button', { name: /search/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/both a check-in and a check-out/i);
    await user.type(screen.getByLabelText('Check-out'), dayFromNow(10));
    await user.click(screen.getByRole('button', { name: /search/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/after check-in/i);
    await user.clear(screen.getByLabelText('Check-in'));
    await user.clear(screen.getByLabelText('Check-out'));
    await user.type(screen.getByLabelText(/Min price/), '500');
    await user.type(screen.getByLabelText(/Max price/), '100');
    await user.click(screen.getByRole('button', { name: /search/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/minimum price/i);
    expect(replace).not.toHaveBeenCalled();
    expect(m.calls.length).toBe(calls);
  });

  it('an API failure is an error with retry, never an empty or made-up list', async () => {
    let n = 0;
    mockFetch(() => (++n === 1 ? fail(500, 'INTERNAL_ERROR', 'boom') : ok(page([item()]))));
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Radha Ashram/ })).toBeInTheDocument();
    expect(screen.queryByText('No stays match your search')).not.toBeInTheDocument();
  });

  it('paginates through the URL', async () => {
    mockFetch(() => ok({ items: [item()], page: 2, limit: 12, total: 30 }));
    const user = userEvent.setup();
    mount('page=2&q=goa');
    await screen.findByText('Page 2 of 3');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(Object.fromEntries(new URL(replace.mock.calls[0][0] as string, 'http://x').searchParams)).toMatchObject({ q: 'goa', page: '3' });
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(new URL(replace.mock.calls[1][0] as string, 'http://x').searchParams.get('page')).toBe('1');
  });

  it('Clear returns to the unfiltered page', async () => {
    mockFetch(() => ok(page([])));
    const user = userEvent.setup();
    mount('q=goa');
    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/stays'));
  });
});
