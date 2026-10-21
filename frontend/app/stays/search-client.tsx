'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { MapPin, Search, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { bookingEngineApi } from '@/lib/api/booking-engine';
import { formatCurrency } from '@/lib/utils/currency';
import type { PublicPropertySearchItem, PublicPropertySearchParams } from '@/types';

const AMENITIES = [
  { value: 'wifi', label: 'WiFi' },
  { value: 'parking', label: 'Parking' },
  { value: 'pool', label: 'Pool' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'spa', label: 'Spa' },
] as const;
const PAGE_SIZE = 12;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** URL -> search parameters. The URL is the single source of truth, so every search can be shared and survives a refresh. */
function fromUrl(sp: URLSearchParams): PublicPropertySearchParams {
  const num = (k: string) => {
    const v = sp.get(k);
    return v !== null && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const checkIn = sp.get('checkIn') ?? '';
  const checkOut = sp.get('checkOut') ?? '';
  const sort = sp.get('sort');
  return {
    q: sp.get('q')?.trim() || undefined,
    ...(DATE_RE.test(checkIn) && DATE_RE.test(checkOut) && checkOut > checkIn ? { checkIn, checkOut, adults: num('adults') ?? 2 } : {}),
    minPrice: num('minPrice'),
    maxPrice: num('maxPrice'),
    amenities: sp.get('amenities')?.split(',').filter(Boolean),
    sort: sort === 'price_asc' || sort === 'price_desc' ? sort : undefined,
    page: num('page') ?? 1,
  };
}

function PropertyCard({ p, stayQuery }: { p: PublicPropertySearchItem; stayQuery: string }) {
  const hasStay = p.availableFromNightly !== undefined;
  return (
    <Link
      href={`/stays/${p.slug}${stayQuery}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs transition hover:shadow-lg dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="relative h-44 w-full bg-slate-100 dark:bg-slate-800">
        {p.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- property photos are arbitrary remote URLs
          <img src={p.image.url} alt={p.image.caption || p.name} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs font-semibold text-slate-500">No photo yet</div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div>
          <h3 className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100">{p.name}</h3>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-indigo-600" aria-hidden="true" />
            {p.city}, {p.state}
          </div>
        </div>
        {p.description && <p className="line-clamp-2 text-xs text-slate-600 dark:text-slate-400">{p.description}</p>}
        {p.amenities.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Amenities">
            {p.amenities.slice(0, 4).map((a) => (
              <li key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {a}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto flex items-end justify-between pt-2">
          <div>
            <span className="block text-[11px] font-medium text-slate-500">{hasStay ? 'From' : 'Starting from'}</span>
            <span className="text-lg font-black text-slate-900 dark:text-slate-100">{formatCurrency(hasStay ? p.availableFromNightly : p.startingFromPrice, p.currency)}</span>
            <span className="text-xs text-slate-500"> / night</span>
          </div>
          {hasStay && p.availableFromTotal !== undefined && (
            <div className="text-right text-[11px] text-slate-500">
              {formatCurrency(p.availableFromTotal, p.currency)} total
              <br />
              for {p.nights} night{p.nights === 1 ? '' : 's'}, taxes incl.
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

export function StaysSearchClient() {
  const router = useRouter();
  const urlParams = useSearchParams();
  const params = useMemo(() => fromUrl(new URLSearchParams(urlParams.toString())), [urlParams]);

  // Form state starts from the URL; submitting writes it back, which re-runs the query.
  const [q, setQ] = useState(params.q ?? '');
  const [checkIn, setCheckIn] = useState(params.checkIn ?? '');
  const [checkOut, setCheckOut] = useState(params.checkOut ?? '');
  const [adults, setAdults] = useState(params.adults ?? 2);
  const [minRupees, setMinRupees] = useState(params.minPrice !== undefined ? String(params.minPrice / 100) : '');
  const [maxRupees, setMaxRupees] = useState(params.maxPrice !== undefined ? String(params.maxPrice / 100) : '');
  const [amenities, setAmenities] = useState<string[]>(params.amenities ?? []);
  const [sort, setSort] = useState(params.sort ?? 'recommended');
  const [formError, setFormError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  const query = useQuery({ queryKey: ['public-property-search', params], queryFn: () => bookingEngineApi.searchProperties(params), staleTime: 30_000 });

  const apply = (extra: Record<string, string | undefined> = {}) => {
    const next = new URLSearchParams();
    const set = (k: string, v: string | undefined) => v && next.set(k, v);
    set('q', q.trim());
    if (checkIn && checkOut) {
      set('checkIn', checkIn);
      set('checkOut', checkOut);
      set('adults', String(adults));
    }
    if (minRupees) set('minPrice', String(Math.round(Number(minRupees) * 100)));
    if (maxRupees) set('maxPrice', String(Math.round(Number(maxRupees) * 100)));
    set('amenities', amenities.join(','));
    if (sort !== 'recommended') set('sort', sort);
    for (const [k, v] of Object.entries(extra)) set(k, v);
    router.replace(`/stays${next.toString() ? `?${next}` : ''}`);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((checkIn && !checkOut) || (!checkIn && checkOut)) return setFormError('Choose both a check-in and a check-out date, or neither.');
    if (checkIn && checkOut && checkOut <= checkIn) return setFormError('Check-out must be after check-in.');
    if (minRupees && maxRupees && Number(minRupees) > Number(maxRupees)) return setFormError('The minimum price cannot be above the maximum.');
    setFormError(null);
    apply();
  };

  // `via=tirvona` marks a booking that started in marketplace search, so it is attributed to the marketplace (the server only honours it for approved listings).
  const stayQuery = `?${new URLSearchParams({ ...(params.checkIn && params.checkOut ? { checkIn: params.checkIn, checkOut: params.checkOut, adults: String(params.adults ?? 2) } : {}), via: 'tirvona' })}`;
  const page = params.page ?? 1;
  const totalPages = query.data ? Math.max(1, Math.ceil(query.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-800 dark:bg-slate-900 sm:p-5" aria-label="Search stays">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Input label="Where to?" placeholder="City, state or property name" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Input label="Check-in" type="date" min={today} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          <Input label="Check-out" type="date" min={checkIn || today} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
          <Select label="Guests" value={String(adults)} onChange={(e) => setAdults(Number(e.target.value))} options={Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} guest${i ? 's' : ''}` }))} />
        </div>

        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Filters and sorting
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input label="Min price per night (₹)" type="number" min={0} step="any" inputMode="decimal" value={minRupees} onChange={(e) => setMinRupees(e.target.value)} />
            <Input label="Max price per night (₹)" type="number" min={0} step="any" inputMode="decimal" value={maxRupees} onChange={(e) => setMaxRupees(e.target.value)} />
            <Select
              label="Sort by"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              options={[
                { value: 'recommended', label: 'Recommended' },
                { value: 'price_asc', label: 'Price: low to high' },
                { value: 'price_desc', label: 'Price: high to low' },
              ]}
            />
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-semibold text-slate-700 dark:text-slate-300">Amenities</legend>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {AMENITIES.map((a) => (
                  <label key={a.value} className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600"
                      checked={amenities.includes(a.value)}
                      onChange={(e) => setAmenities(e.target.checked ? [...amenities, a.value] : amenities.filter((x) => x !== a.value))}
                    />
                    {a.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </details>

        {formError && (
          <p role="alert" className="text-xs font-semibold text-rose-600">
            {formError}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit">
            <Search className="mr-2 h-4 w-4" aria-hidden="true" /> Search
          </Button>
          {urlParams.toString() && (
            <Button type="button" variant="outline" onClick={() => router.replace('/stays')}>
              Clear
            </Button>
          )}
        </div>
      </form>

      {query.isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-live="polite">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-72 w-full rounded-2xl" />
          ))}
        </div>
      )}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.isSuccess && (
        <section className="space-y-4" aria-live="polite">
          <p className="text-xs font-medium text-slate-500">
            {query.data.total} stay{query.data.total === 1 ? '' : 's'} found{params.checkIn && params.checkOut ? ` for ${params.checkIn} to ${params.checkOut}` : ''}
          </p>
          {query.data.items.length === 0 ? (
            <EmptyState title="No stays match your search" hint="Try other dates, a wider price range, or fewer filters." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {query.data.items.map((p) => (
                <PropertyCard key={p.slug} p={p} stayQuery={stayQuery} />
              ))}
            </div>
          )}
          {totalPages > 1 && (
            <nav className="flex items-center justify-center gap-3 pt-2" aria-label="Pagination">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => apply({ page: String(page - 1) })}>
                Previous
              </Button>
              <span className="text-xs text-slate-500">
                Page {page} of {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => apply({ page: String(page + 1) })}>
                Next
              </Button>
            </nav>
          )}
        </section>
      )}
    </div>
  );
}
