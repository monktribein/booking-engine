import type { ClientSession, TransactionOptions } from 'mongodb';
import type { Connection } from 'mongoose';

/**
 * Transaction settings for every multi-document write in Tirvona.
 *  - snapshot read concern: the transaction reads one consistent point in time.
 *  - majority write concern: a commit survives a primary failover.
 *  - primary read preference: transactions must read from the primary.
 */
export const TXN_OPTIONS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
  maxCommitTimeMS: 10_000,
};

/**
 * Runs `fn` in a transaction through the driver's withTransaction loop, which
 * retries the whole callback on TransientTransactionError (for example a
 * WriteConflict from a concurrent booking on the same inventory row) and
 * retries the commit on UnknownTransactionCommitResult.
 *
 * Because `fn` can run more than once:
 *  - pass `session` to every read and write inside it;
 *  - do NOT call external APIs, send email or publish events inside it. Write
 *    an outbox row (sync_jobs, notifications) instead, and let a worker act
 *    after commit.
 */
export function runInTransaction<T>(connection: Connection, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  return connection.transaction(fn, TXN_OPTIONS);
}
