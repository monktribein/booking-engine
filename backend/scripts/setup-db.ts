/**
 * Creates collections, server-side validators and indexes. Idempotent.
 * Run it in CI/CD before each deploy (the app runs with autoIndex=false in
 * production):
 *
 *   MONGODB_URI=... npm run db:setup            # create missing indexes
 *   MONGODB_URI=... npm run db:setup -- --prune # also drop indexes no schema declares
 */
import 'dotenv/config';
import mongoose, { Connection } from 'mongoose';
import { COLLECTION } from '../src/database/constants';
import { MODEL_DEFINITIONS, registerModels } from '../src/database/models';

/**
 * Defence in depth for the one invariant that must never break. Even a buggy
 * code path or a manual mongosh update cannot leave `available` negative or
 * the counters inconsistent: the server rejects the write (error 121).
 */
export const INVENTORY_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['propertyId', 'roomTypeId', 'date', 'total', 'sold', 'blocked', 'available', 'overbooked', 'stopSell'],
    properties: {
      propertyId: { bsonType: 'objectId' },
      roomTypeId: { bsonType: 'objectId' },
      date: { bsonType: 'date' },
      total: { bsonType: 'number', minimum: 0 },
      sold: { bsonType: 'number', minimum: 0 },
      blocked: { bsonType: 'number', minimum: 0 },
      available: { bsonType: 'number', minimum: 0 },
      overbooked: { bsonType: 'number', minimum: 0 },
      stopSell: { bsonType: 'bool' },
    },
  },
  $expr: {
    $eq: [{ $add: ['$available', '$sold', '$blocked'] }, { $add: ['$total', '$overbooked'] }],
  },
};

export const RESERVATION_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['propertyId', 'reservationCode', 'source', 'status', 'checkIn', 'checkOut', 'total', 'currency'],
    properties: {
      total: { bsonType: 'number', minimum: 0 },
      amountPaid: { bsonType: 'number', minimum: 0 },
      amountRefunded: { bsonType: 'number', minimum: 0 },
    },
  },
  $expr: { $lt: ['$checkIn', '$checkOut'] },
};

const VALIDATORS: Record<string, object> = {
  [COLLECTION.inventory]: INVENTORY_VALIDATOR,
  [COLLECTION.reservations]: RESERVATION_VALIDATOR,
};

export async function setupDatabase(conn: Connection, opts: { prune?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? console.log;
  registerModels(conn);
  const db = conn.db!;
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const { name } of MODEL_DEFINITIONS) {
    const model = conn.model(name);
    const coll = model.collection.collectionName;
    const validator = VALIDATORS[coll];
    let created = false;
    if (!existing.has(coll)) {
      try {
        await db.createCollection(coll, validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {});
        created = true;
        log(`created ${coll}`);
      } catch (err) {
        // Created concurrently (another deploy, or Mongoose autoCreate). Fall through to collMod.
        if ((err as { code?: number }).code !== 48) throw err;
      }
    }
    if (!created && validator) {
      await db.command({ collMod: coll, validator, validationLevel: 'strict', validationAction: 'error' });
    }

    if (opts.prune) {
      const dropped = await model.syncIndexes();
      if (dropped.length) log(`${coll}: dropped ${dropped.join(', ')}`);
    } else {
      await model.createIndexes();
    }
    const names = (await model.collection.indexes()).map((i) => i.name);
    log(`${coll}: ${names.length} indexes`);
  }
}

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    const conn = await mongoose.createConnection(uri, { dbName: process.env.MONGODB_DB ?? 'tirvona', autoIndex: false, autoCreate: false }).asPromise();
    try {
      await setupDatabase(conn, { prune: process.argv.includes('--prune') });
    } finally {
      await conn.close();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
