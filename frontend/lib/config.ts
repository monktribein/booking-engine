/**
 * Runtime safety checks for the frontend.
 *
 * Demo mode only ever pre-fills the seeded owner e-mail on the login form. It never authenticates anyone, never fabricates
 * tokens and never replaces an API response: every sign-in still goes through the real backend.
 *
 * It fails closed: a production build/runtime with NEXT_PUBLIC_DEMO_MODE=true throws. There is deliberately no override flag.
 *
 * NEXT_PUBLIC_* values are bundled into client JavaScript, so never put secrets in them.
 */

export class UnsafeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeConfigError';
  }
}

interface ConfigEnv {
  NODE_ENV?: string;
  NEXT_PUBLIC_DEMO_MODE?: string;
  [key: string]: string | undefined;
}

export function isDemoMode(env: ConfigEnv = process.env as ConfigEnv): boolean {
  const requested = env.NEXT_PUBLIC_DEMO_MODE?.trim().toLowerCase() === 'true';
  if (requested && env.NODE_ENV === 'production') {
    throw new UnsafeConfigError('NEXT_PUBLIC_DEMO_MODE=true is not allowed in a production build. Unset it and redeploy.');
  }
  return requested;
}

/** Names that suggest a secret was put into a browser-visible variable. */
const SECRET_LOOKING = /(SECRET|PRIVATE|PASSWORD|PASSWD|TOKEN|API_KEY|ACCESS_KEY|CREDENTIAL|JWT)/i;

/**
 * Called once at server start (instrumentation.ts) when NODE_ENV=production. Throws, so the process refuses to start
 * with a configuration that would be unsafe or silently broken:
 *  - demo mode on
 *  - no / invalid browser-facing API URL (NEXT_PUBLIC_API_URL, compiled in at build time)
 *  - plain http API URL without an explicit ALLOW_INSECURE_API_URL=true (local production-mode runs only)
 *  - an invalid server-side API_INTERNAL_URL
 *  - any NEXT_PUBLIC_* variable whose name looks like a secret
 */
export function assertProductionRuntimeConfig(env: ConfigEnv = process.env as ConfigEnv): void {
  if (env.NODE_ENV !== 'production') return;
  const errors: string[] = [];

  if (env.NEXT_PUBLIC_DEMO_MODE?.trim().toLowerCase() === 'true') errors.push('NEXT_PUBLIC_DEMO_MODE=true is not allowed in production');

  const api = env.NEXT_PUBLIC_API_URL;
  if (!api) errors.push('NEXT_PUBLIC_API_URL is required (set it as a build argument; it is compiled into the browser bundle)');
  else {
    try {
      const u = new URL(api);
      if (!['http:', 'https:'].includes(u.protocol)) errors.push('NEXT_PUBLIC_API_URL must be an http(s) URL');
      else if (u.protocol === 'http:' && env.ALLOW_INSECURE_API_URL !== 'true') {
        errors.push('NEXT_PUBLIC_API_URL must be https in production (set ALLOW_INSECURE_API_URL=true only for a local production-mode run)');
      }
      if (u.pathname !== '/' || u.search || u.hash) errors.push('NEXT_PUBLIC_API_URL must be an origin without path, query or fragment');
    } catch {
      errors.push('NEXT_PUBLIC_API_URL is not a valid URL');
    }
  }

  if (env.API_INTERNAL_URL) {
    try {
      new URL(env.API_INTERNAL_URL);
    } catch {
      errors.push('API_INTERNAL_URL is not a valid URL');
    }
  }

  for (const key of Object.keys(env)) {
    if (key.startsWith('NEXT_PUBLIC_') && SECRET_LOOKING.test(key.slice('NEXT_PUBLIC_'.length))) {
      errors.push(`${key} looks like a secret but NEXT_PUBLIC_* variables are visible to every visitor`);
    }
  }

  if (errors.length) throw new UnsafeConfigError(`Invalid frontend configuration:\n - ${errors.join('\n - ')}`);
}
