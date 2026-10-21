import type { MetadataRoute } from 'next';

const siteUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001').replace(/\/$/, '');

/**
 * Public pages (landing, search, property pages) may be indexed. Everything behind a login, the sign-in pages themselves and
 * the booking flow (which carries booking references and guest details) must not be.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: ['/', '/stays'], disallow: ['/dashboard', '/admin', '/booking', '/api', '/login', '/register', '/forgot-password', '/reset-password', '/oauth'] }],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
