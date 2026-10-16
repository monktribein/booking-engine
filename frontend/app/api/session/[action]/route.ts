import { handleSession } from '@/lib/server/session-proxy';

export const dynamic = 'force-dynamic';

/**
 * /api/session/login | register | refresh | logout. See lib/server/session-proxy.ts: the refresh token lives in an HttpOnly
 * cookie that only this route reads or writes.
 */
export async function POST(request: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  return handleSession(action, request, {
    apiBase: process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
    bffSecret: process.env.BFF_SHARED_SECRET || undefined,
  });
}

// Everything else is refused by handleSession's method check; only POST is exported on purpose.
