import { Injectable } from '@nestjs/common';
import { decryptSecret, encryptSecret } from '../../../database/common/crypto';
import { ConnectionSecretKind } from '../../../database/enums';
import { DomainValidationError } from '../../../database/errors';
import { Db, InjectDb } from '../../../database/kysely';
import type { ProviderSecrets } from './generic-rest.adapter';

/** Which secret kinds a definition's auth / signing / webhook specs need from the owner of a connection. */
export const SECRET_KINDS_FOR_AUTH: Record<string, ConnectionSecretKind[]> = {
  NONE: [],
  API_KEY_HEADER: [ConnectionSecretKind.API_KEY],
  API_KEY_QUERY: [ConnectionSecretKind.API_KEY],
  BEARER: [ConnectionSecretKind.BEARER_TOKEN],
  BASIC: [ConnectionSecretKind.BASIC_USERNAME, ConnectionSecretKind.BASIC_PASSWORD],
};

const ALLOWED: readonly string[] = Object.values(ConnectionSecretKind);
const MAX_SECRET_LENGTH = 4096;

/**
 * Per-connection credentials of any kind, stored as AES-256-GCM envelopes (the same format as the OAuth token columns). Values are
 * written and decrypted here and nowhere else; reads for the UI return only which secrets exist, never their value.
 * Every method is keyed by connection id: callers must already have proven the connection belongs to the caller's tenant.
 */
@Injectable()
export class ConnectionSecretsService {
  constructor(@InjectDb() private readonly db: Db) {}

  async set(connectionId: string, secrets: Partial<Record<ConnectionSecretKind, string>>): Promise<ConnectionSecretKind[]> {
    const written: ConnectionSecretKind[] = [];
    for (const [kind, value] of Object.entries(secrets)) {
      if (!ALLOWED.includes(kind)) throw new DomainValidationError(`Unknown credential type ${kind}`);
      if (typeof value !== 'string' || value.length === 0) continue;
      if (value.length > MAX_SECRET_LENGTH || /[\r\n\u0000]/.test(value)) throw new DomainValidationError(`The ${kind} value is not valid`);
      const ciphertext = encryptSecret(value);
      await this.db
        .insertInto('channelConnectionSecrets')
        .values({ connectionId, kind, name: '', ciphertext })
        .onConflict((oc) => oc.columns(['connectionId', 'kind', 'name']).doUpdateSet({ ciphertext, rotatedAt: new Date() }))
        .execute();
      written.push(kind as ConnectionSecretKind);
    }
    return written;
  }

  /** Decrypted secrets for building an adapter. Never log or return the result. */
  async load(connectionId: string): Promise<ProviderSecrets> {
    const rows = await this.db.selectFrom('channelConnectionSecrets').select(['kind', 'ciphertext']).where('connectionId', '=', connectionId).where('name', '=', '').execute();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.kind] = decryptSecret(r.ciphertext);
    return out as ProviderSecrets;
  }

  /** What is stored, without any value: for the connection screen. */
  async describe(connectionId: string): Promise<{ kind: string; createdAt: Date; rotatedAt: Date | null }[]> {
    return this.db.selectFrom('channelConnectionSecrets').select(['kind', 'createdAt', 'rotatedAt']).where('connectionId', '=', connectionId).orderBy('kind').execute();
  }

  async deleteAll(connectionId: string): Promise<void> {
    await this.db.deleteFrom('channelConnectionSecrets').where('connectionId', '=', connectionId).execute();
  }
}
