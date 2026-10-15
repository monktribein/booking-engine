import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One throwaway single-node replica set for the whole run (transactions need a
 * replica set). Each test file uses its own database on it.
 */
export default async function globalSetup(): Promise<void> {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  (globalThis as unknown as { __MONGO_RS__: MongoMemoryReplSet }).__MONGO_RS__ = rs;
  process.env.TEST_MONGODB_URI = rs.getUri();
}
