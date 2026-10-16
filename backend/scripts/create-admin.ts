/**
 * Creates a PLATFORM staff account (it belongs to no partner organization).
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" npm run admin:create:dev            # random password, printed once
 *   ADMIN_EMAIL=... ADMIN_NAME=... ADMIN_PASSWORD='at least 12 characters' ADMIN_ROLE=OPERATIONS_ADMIN npm run admin:create:dev
 *
 * ADMIN_ROLE is SUPER_ADMIN (default) or OPERATIONS_ADMIN. Uses DATABASE_URL from the environment / backend/.env.
 * Platform accounts cannot be created through the API on purpose: nobody can register themselves as an administrator.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/database/common/crypto';
import { UserRole, UserStatus } from '../src/database/enums';
import { createDb, createPool } from '../src/database/kysely';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const name = (process.env.ADMIN_NAME ?? '').trim();
  const role = (process.env.ADMIN_ROLE ?? UserRole.SUPER_ADMIN) as UserRole;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL must be a valid e-mail address');
  if (!name) throw new Error('ADMIN_NAME is required');
  if (![UserRole.SUPER_ADMIN, UserRole.OPERATIONS_ADMIN].includes(role)) throw new Error('ADMIN_ROLE must be SUPER_ADMIN or OPERATIONS_ADMIN');
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD ?? `${randomBytes(15).toString('base64url')}!9`;
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');

  const pool = createPool({ url, ssl: process.env.DATABASE_SSL as 'disable' | 'require' | 'verify-full' | undefined, caCert: process.env.DATABASE_CA_CERT, poolMax: 2, applicationName: 'tirvona-admin-create' });
  const db = createDb(pool);
  try {
    if (await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()) throw new Error(`A user with ${email} already exists`);
    await db
      .insertInto('users')
      .values({ organizationId: null, name, email, phone: null, passwordHash: await hashPassword(password), role, status: UserStatus.ACTIVE, lastLoginAt: null })
      .execute();
    console.log(`Created ${role} ${email}`);
    if (generated) console.log(`Password (shown once, change it after the first login): ${password}`);
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
