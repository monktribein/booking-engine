import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/configuration';
import { DB_TOKEN, Db, POOL_TOKEN, createDb, createPool } from './kysely';
export { InjectDb } from './kysely';
import { DATABASE_SERVICES } from './services';

@Injectable()
class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(POOL_TOKEN) private readonly pool: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}

/**
 * One PostgreSQL database (Supabase in production) for the whole modular monolith. Feature modules use these services
 * and the shared Kysely instance. None of them opens its own connection. The schema is owned by SQL migrations
 * (`npm run db:migrate`), never created by the application at boot.
 */
@Global()
@Module({
  providers: [
    {
      provide: POOL_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Pool => {
        const d = config.get('database', { infer: true });
        return createPool({ url: d.url, poolMax: d.poolMax, ssl: d.ssl, caCert: d.caCert });
      },
    },
    { provide: DB_TOKEN, inject: [POOL_TOKEN], useFactory: (pool: Pool): Db => createDb(pool) },
    PoolShutdown,
    ...DATABASE_SERVICES,
  ],
  exports: [POOL_TOKEN, DB_TOKEN, ...DATABASE_SERVICES],
})
export class DatabaseModule {}
