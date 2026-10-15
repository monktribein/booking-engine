import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness for the container health check: the Next.js server answers. It deliberately does not call the API (a backend
 * outage must not make the orchestrator restart healthy web containers). `?deep=1` additionally reports whether the API
 * is reachable, for monitoring.
 */
export async function GET(request: Request) {
  const body: { status: 'ok' | 'degraded'; api?: 'up' | 'down' } = { status: 'ok' };
  if (new URL(request.url).searchParams.get('deep') === '1') {
    const base = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
      body.api = res.ok ? 'up' : 'down';
    } catch {
      body.api = 'down';
    }
    if (body.api === 'down') body.status = 'degraded';
    return NextResponse.json(body, { status: body.status === 'ok' ? 200 : 503 });
  }
  return NextResponse.json(body);
}
