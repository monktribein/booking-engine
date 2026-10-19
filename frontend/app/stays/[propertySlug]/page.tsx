import React from 'react';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { addDays, format } from 'date-fns';
import { ApiError } from '@/lib/api/client';
import { bookingEngineApi } from '@/lib/api/booking-engine';
import { PublicBookingClient } from './booking-client';
import { PropertyHeroGallery } from '@/components/booking/PropertyHeroGallery';
import { PropertyInfoCards } from '@/components/booking/PropertyInfoCards';
import { formatCurrency } from '@/lib/utils/currency';
import { MapPin, ShieldCheck } from 'lucide-react';
import { BrandLogo } from '@/components/ui/brand-logo';

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
      <header className="sticky top-0 z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-stone-200/90 dark:border-slate-800">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <BrandLogo href="/" subtitle="Direct Booking" />

          <div className="flex items-center gap-3">
            <Link href="/stays" className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900">
              All stays
            </Link>
            <Link href="/booking/lookup"
              className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900"
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
                <MapPin className="h-4 w-4 text-sky-600 shrink-0" />
                <span>
                  {property.address}, {property.city}, {property.state}
                </span>
              </div>
            </div>

            {startingFrom !== null && (
              <div className="text-right">
                <span className="text-xs text-slate-400 block font-medium">Starting from</span>
                <span className="text-2xl font-black text-slate-900 dark:text-slate-100">{formatCurrency(startingFrom, property.currency)}</span>
                <span className="text-xs text-slate-400"> / night</span>
              </div>
            )}
          </div>
        </div>

        {/* Hero Photo Gallery with verified fallbacks and error handling */}
        <PropertyHeroGallery
          propertyName={property.name}
          images={property.images}
          locationText={`${property.city}, ${property.state}`}
        />

        {/* Animated Property Overview & 3-Column Information Cards */}
        <PropertyInfoCards
          propertyName={property.name}
          description={property.description}
          amenities={property.amenities}
          checkInTime={property.checkInTime}
          checkOutTime={property.checkOutTime}
          address={property.address}
          city={property.city}
          state={property.state}
          country={property.country}
        />

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
