import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pwd: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

/** Format: scrypt$N$r$p$saltB64$hashB64. Never store plaintext. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new RangeError('Password must be at least 8 characters');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(expected, actual);
}

/** Accepts scrypt (ours), bcrypt and argon2 encodings; rejects anything that could be plaintext. */
export const PASSWORD_HASH_RE = /^(scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+|\$2[aby]\$\d{2}\$.{53}|\$argon2(id|i|d)\$.+)$/;

// ---------------------------------------------------------------- field-level secrets

/**
 * AES-256-GCM envelope for channel OAuth tokens and other API secrets.
 * Format: v1:<ivB64>:<tagB64>:<ciphertextB64>
 *
 * The 32-byte key comes from ENCRYPTION_KEY (base64). In production load it
 * from a KMS (AWS KMS / GCP KMS / Azure Key Vault) and rotate by adding a v2
 * prefix. For stronger guarantees use Atlas Client-Side Field Level
 * Encryption; see docs/DATABASE.md §20.
 */
export const ENCRYPTED_SECRET_RE = /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

function dataKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? process.env.TIRVONA_DATA_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(envelope: string): string {
  const [v, ivB64, tagB64, ctB64] = envelope.split(':');
  if (v !== 'v1') throw new Error(`Unsupported secret envelope version "${v}"`);
  const decipher = createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
