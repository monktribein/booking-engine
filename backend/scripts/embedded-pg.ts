/**
 * A throwaway real PostgreSQL server (the `embedded-postgres` dev dependency ships the official binaries) for tests, the
 * local sandbox, the OpenAPI export and the restore drill. Nothing outside this process tree is touched: the cluster
 * lives in a temp directory and is deleted on stop().
 */
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

export interface EphemeralPg {
  /** Connection string of the named database (default: the maintenance database `postgres`). */
  url(database?: string): string;
  createDatabase(name: string): Promise<string>;
  dropDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });

export async function startEphemeralPg(): Promise<EphemeralPg> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirvona-pg-'));
  const port = await freePort();
  const password = 'tirvona-local';
  const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password, port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  const url = (database = 'postgres') => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
  const admin = async <T>(fn: (c: Client) => Promise<T>) => {
    const c = new Client({ connectionString: url() });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  return {
    url,
    async createDatabase(name) {
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error('bad database name');
      await admin((c) => c.query(`create database ${name} template template0 encoding 'UTF8'`));
      return url(name);
    },
    async dropDatabase(name) {
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error('bad database name');
      await admin((c) => c.query(`drop database if exists ${name} with (force)`));
    },
    async stop() {
      await pg.stop().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
