import 'dotenv/config';
import { createPool, createDb, j } from '../src/database/kysely';
import { sql } from 'kysely';

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const pool = createPool({ url, poolMax: 1 });
  const db = createDb(pool);

  const images = [
    {
      url: '/images/stays/radha-ashram-facade.jpg',
      caption: 'Radha Ashram - Main Entrance & Temple Spire',
      sortOrder: 0,
    },
    {
      url: '/images/stays/radha-ashram-courtyard.jpg',
      caption: 'Sacred Courtyard & Colonnade',
      sortOrder: 1,
    },
    {
      url: 'https://images.unsplash.com/photo-1662376107358-21296a9234f1?auto=format&fit=crop&w=1200&q=80',
      caption: 'Prem Mandir & Vrindavan Grounds',
      sortOrder: 2,
    },
  ];

  await db
    .updateTable('properties')
    .set({ images: sql`${j(images)}::jsonb` })
    .where('slug', '=', 'radha-ashram')
    .execute();

  console.log('SUCCESSFULLY_UPDATED_RADHA_ASHRAM_VRINDAVAN_IMAGES');
  await pool.end();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
