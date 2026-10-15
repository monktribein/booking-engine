import { assertProductionRuntimeConfig } from './config';

/** Node.js runtime only (imported dynamically from instrumentation.ts). Exits with code 1 on an unsafe production configuration. */
export function verifyStartupConfig(): void {
  try {
    assertProductionRuntimeConfig({
      ...process.env,
      // Literal accesses on purpose: Next.js inlines these two at BUILD time, which is the value the browser bundle really
      // contains. The runtime container does not need them set again.
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE,
    });
  } catch (err) {
    console.error(JSON.stringify({ level: 'fatal', service: 'tirvona-frontend', event: 'invalid_configuration', message: (err as Error).message }));
    process.exit(1);
  }
}
