import type { Instrumentation } from 'next';

/**
 * Runs once when a Next.js server instance starts. In production it refuses to start with unsafe configuration: the process
 * exits with code 1 (so an orchestrator restarts/blocks the rollout instead of keeping a half-working instance).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { verifyStartupConfig } = await import('./lib/startup');
  verifyStartupConfig();
}

/**
 * Structured (one JSON object per line) server-side error log. Deliberately minimal and PII-safe: no query string, no
 * headers, no cookies, no request body, message truncated. Stack traces stay out of the log line (the digest correlates
 * with the browser-visible error id). Ship stdout to the log platform; add an error tracker here if one is adopted.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const e = err as { message?: string; digest?: string; name?: string };
  const path = (request.path ?? '').split('?')[0];
  console.error(
    JSON.stringify({
      level: 'error',
      ts: new Date().toISOString(),
      service: 'tirvona-frontend',
      event: 'request_error',
      method: request.method,
      path: path.replace(/\/TRV-[A-Z0-9]+/g, '/:code'), // booking codes are customer identifiers
      routePath: context.routePath,
      routeType: context.routeType,
      errorName: e.name,
      digest: e.digest,
      message: String(e.message ?? '').slice(0, 300),
    })
  );
};
