import React from 'react';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { addDays, format } from 'date-fns';
import { ApiError } from '@/lib/api/client';
import { bookingEngineApi } from '@/lib/api/booking-engine';
import { PublicBookingClient } from './booking-client';
import { formatCurrency } from '@/lib/utils/currency';
import { MapPin, ShieldCheck, Sparkles, Check } from 'lucide-react';

interface Props {
  params: Promise<{ propertySlug: string }>;
  /** Dates and party size carried over from the search results page (?checkIn=&checkOut=&adults=). */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Server-rendered Dynamic SEO Metadata & Open Graph
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { propertySlug } = await params;
  try {
    const property = await bookingEngineApi.getPublicProperty(propertySlug);
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://tirvona.example';
    const canonical = `${siteUrl}/stays/${propertySlug}`;

    return {
      title: `${property.name} - Direct Booking & Best Rates | Tirvona`,
      description: (property.description ?? '').slice(0, 160),
      alternates: {
        canonical,
      },
      openGraph: {
        title: `${property.name} - Reserve Directly for Best Price`,
        description: (property.description ?? '').slice(0, 160),
        url: canonical,
        siteName: 'Tirvona Hospitality',
        images: property.images.map((img) => ({
          url: img.url,
          alt: img.caption || property.name,
        })),
        locale: 'en_IN',
        type: 'website',
      },
      twitter: {
        card: 'summary_large_image',
        title: property.name,
        description: (property.description ?? '').slice(0, 160),
        images: property.images[0]?.url ? [property.images[0].url] : [],
      },
    };
  } catch {
    return {
      title: 'Hotel Stay | Tirvona Direct Booking',
    };
  }
}

export default async function PropertyStayPage({ params, searchParams }: Props) {
  const { propertySlug } = await params;
  const sp = (await searchParams) ?? {};
  let property;
  try {
    property = await bookingEngineApi.getPublicProperty(propertySlug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err; // anything else renders the route's error.tsx, never placeholder data
  }
  const startingFrom = property.roomTypes.length ? Math.min(...property.roomTypes.map((rt) => rt.startingFromPrice)) : null;
  const qIn = first(sp.checkIn);
  const qOut = first(sp.checkOut);
  const fromSearch = !!qIn && !!qOut && DATE_RE.test(qIn) && DATE_RE.test(qOut) && qOut > qIn;
  const defaultCheckIn = fromSearch ? (qIn as string) : format(addDays(new Date(), 1), 'yyyy-MM-dd');
  const defaultCheckOut = fromSearch ? (qOut as string) : format(addDays(new Date(), 3), 'yyyy-MM-dd');
  const qAdults = Number(first(sp.adults));
  const defaultAdults = Number.isInteger(qAdults) && qAdults >= 1 && qAdults <= 50 ? qAdults : 2;

  // Schema.org Structured Data for SEO / Rich Snippets
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LodgingBusiness',
    name: property.name,
    description: property.description,
    address: {
      '@type': 'PostalAddress',
      streetAddress: property.address,
      addressLocality: property.city,
      addressRegion: property.state,
      addressCountry: property.country,
    },
    checkinTime: property.checkInTime,
    checkoutTime: property.checkOutTime,
    amenityFeature: property.amenities.map((a) => ({
      '@type': 'LocationFeatureSpecification',
      name: a,
      value: true,
    })),
    image: property.images.map((i) => i.url),
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 font-sans text-slate-900 dark:text-slate-100">
      {/* Schema.org Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Guest Navigation Bar */}
      <header className="sticky top-0 z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 text-white shadow-md">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white">
                Tirvona Direct
              </span>
              <span className="hidden sm:inline-block text-[10px] text-slate-400 ml-2 font-medium">
                Official Hotel Booking Portal
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link href="/stays" className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-indigo-600">
              All stays
            </Link>
            <Link href="/booking/lookup"
              className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-indigo-600"
            >
              Find Existing Booking
            </Link>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-8">
        {/* Title & Location Header */}
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 px-3 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            <ShieldCheck className="h-3.5 w-3.5" /> Book direct with the property
          </div>

          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
            <div>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-black tracking-tight text-slate-900 dark:text-slate-50">
                {property.name}
              </h1>
              <div className="flex items-center gap-2 text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
                <MapPin className="h-4 w-4 text-indigo-600 shrink-0" />
                <span>
                  {property.address}, {property.city}, {property.state}
                </span>
              </div>
            </div>

            {startingFrom !== null && (
              <div className="text-right">
                <span className="text-xs text-slate-400 block font-medium">Starting from</span>
                <span className="text-2xl font-black text-indigo-600 dark:text-indigo-400">{formatCurrency(startingFrom, property.currency)}</span>
                <span className="text-xs text-slate-400"> / night</span>
              </div>
            )}
          </div>
        </div>

        {/* Hero Photo Grid: only the property's own photos */}
        {property.images.length > 0 && (
          <div className={`grid grid-cols-1 ${property.images.length > 1 ? 'md:grid-cols-3' : ''} gap-3 h-[320px] sm:h-[420px] rounded-3xl overflow-hidden shadow-md`}>
            {property.images.slice(0, 3).map((img, i) => (
              <div key={i} className={`relative group overflow-hidden ${i === 0 && property.images.length > 1 ? 'md:col-span-2' : ''} h-full`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.caption || property.name} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
              </div>
            ))}
          </div>
        )}

        {/* Server-Rendered Property Description & Highlights */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <div className="prose dark:prose-invert max-w-none text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
              <p>{property.description}</p>
            </div>

            {/* Amenities Grid */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 p-5 bg-white dark:bg-slate-900 space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">
                Property Amenities
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {property.amenities.map((amenity, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
                    <Check className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>{amenity}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Policies */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 p-5 bg-white dark:bg-slate-900 space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">
                Property Rules & Policies
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="font-bold text-slate-900 dark:text-slate-100 block">Check-in / Check-out</span>
                  <p className="text-slate-600 dark:text-slate-400 mt-0.5">
                    Check-in: {property.checkInTime} • Check-out: {property.checkOutTime}
                  </p>
                </div>
                <div>
                  <span className="font-bold text-slate-900 dark:text-slate-100 block">Cancellation Policy</span>
                  <p className="text-slate-600 dark:text-slate-400 mt-0.5">
                    Cancellation terms depend on the rate plan you choose and are shown before you book.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Property Contact Card */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 p-5 bg-white dark:bg-slate-900 space-y-4 shadow-sm">
              <h3 className="font-bold text-base text-slate-900 dark:text-slate-100">
                Contact & Location
              </h3>
              <div className="space-y-2.5 text-xs">
                <div className="flex items-start gap-2.5 text-slate-600 dark:text-slate-300">
                  <MapPin className="h-4 w-4 text-indigo-600 shrink-0 mt-0.5" />
                  <span>{property.address}, {property.city}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Dynamic Availability & Room Booking Section (Interactive Client Component) */}
        <div id="availability-section" className="space-y-6 pt-6">
          <div className="text-center space-y-1">
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Select Your Room & Dates
            </h2>
            <p className="text-xs sm:text-sm text-slate-500">
              Live prices and instant confirmation directly with {property.name}.
            </p>
          </div>

          <PublicBookingClient propertySlug={propertySlug} currency={property.currency} initialRoomTypes={property.roomTypes} defaultCheckIn={defaultCheckIn} defaultCheckOut={defaultCheckOut} defaultAdults={defaultAdults} />
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-16 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-8 text-center text-xs text-slate-400">
        <div className="mx-auto max-w-7xl px-4">
          © {new Date().getFullYear()} {property.name}. Powered by Tirvona Hospitality Engine.
        </div>
      </footer>
    </div>
  );
}
