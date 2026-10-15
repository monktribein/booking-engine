import type { EphemeralPg } from '../scripts/embedded-pg';

export default async function globalTeardown(): Promise<void> {
  await (globalThis as unknown as { __PG__?: EphemeralPg }).__PG__?.stop();
}
