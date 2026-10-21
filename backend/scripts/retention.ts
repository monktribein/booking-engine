/**
 * Personal-data retention from the command line. Dry run by default: it only counts.
 *
 *   DATABASE_URL=postgres://... npm run retention:dry-run:dev -- --org <organization uuid>
 *   DATABASE_URL=postgres://... npm run retention:dry-run:dev -- --all
 *
 * Applying needs the policy to be enabled and approved by an owner, AND an explicit flag on this command:
 *
 *   ... -- --org <uuid> --apply --confirm ANONYMIZE
 *
 * Never run --apply against production without the product owner's written approval of the retention periods.
 * Output contains counts only, never personal data.
 */
import 'dotenv/config';
import { createDb, createPool } from '../src/database/kysely';
import { organizationsWithActivePolicy, runRetention } from '../src/database/services/retention';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (process.argv[i + 1] ?? '');
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const apply = flag('apply');
  if (apply && arg('confirm') !== 'ANONYMIZE') throw new Error('--apply needs --confirm ANONYMIZE');
  const pool = createPool({ url, ssl: process.env.DATABASE_SSL as 'disable' | 'require' | 'verify-full' | undefined, caCert: process.env.DATABASE_CA_CERT, poolMax: 2, applicationName: 'tirvona-retention' });
  const db = createDb(pool);
  try {
    const org = arg('org');
    if (!org && !flag('all')) throw new Error('Pass --org <uuid> or --all');
    const orgs = org ? [org] : flag('apply') ? await organizationsWithActivePolicy(db) : (await db.selectFrom('dataRetentionPolicies').select('organizationId').execute()).map((r) => r.organizationId);
    for (const organizationId of orgs) {
      const r = await runRetention(db, organizationId, { dryRun: !apply, triggeredBy: 'cli' });
      console.log(JSON.stringify({ organizationId, mode: apply ? 'APPLY' : 'DRY-RUN', applied: r.applied, reason: r.reason, ...r.summary, moreGuests: r.moreGuests }));
    }
    if (!orgs.length) console.log('No organization has a retention policy' + (apply ? ' that is enabled and approved' : '') + '.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
