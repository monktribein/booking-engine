import type { MetadataRoute } from 'next';
import { apiClient } from '@/lib/api/client';
import type { PublicPropertySearchResult } from '@/types';

const siteUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001').replace(/\/$/, '');
const PAGE_SIZE = 24; // the API maximum
const MAX_PAGES = 40; // 960 properties; beyond that a precomputed sitemap index is needed

// Property pages come from the live API, so the sitemap is built on request rather than frozen at build time.
export const dynamic = 'force-dynamic';

/**
 * Landing, search and one URL per publicly bookable property. If the API cannot be reached the sitemap lists only the static
 * pages: it never invents property URLs, and a crawler can simply fetch it again later.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${siteUrl}/stays`, changeFrequency: 'daily', priority: 0.8 },
  ];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await apiClient<PublicPropertySearchResult>('/public/properties', { params: { limit: PAGE_SIZE, page }, skipAuth: true });
      for (const p of res.items) entries.push({ url: `${siteUrl}/stays/${encodeURIComponent(p.slug)}`, changeFrequency: 'weekly', priority: 0.7 });
      if (page * PAGE_SIZE >= res.total || res.items.length === 0) break;
    }
  } catch {
    // intentionally partial: static pages only
  }
  return entries;
}
