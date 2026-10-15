import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { AppConfig } from '../config/configuration';
import { MODEL_DEFINITIONS } from './models';
import { DATABASE_SERVICES } from './services';

/**
 * One MongoDB database for the whole modular monolith. Feature modules use
 * these services and models. None of them opens its own connection or database.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const mongodb = config.get('mongodb', { infer: true });
        const isProd = config.get('env', { infer: true }) === 'production';
        return {
          uri: mongodb.uri,
          dbName: mongodb.dbName,
          appName: 'tirvona-api',
          // Indexes and validators are created by `npm run db:setup` in CI/CD, never by app boot in production.
          autoIndex: !isProd,
          autoCreate: !isProd,
          maxPoolSize: mongodb.maxPoolSize,
          minPoolSize: 2,
          serverSelectionTimeoutMS: 10_000,
          socketTimeoutMS: 45_000,
          retryWrites: true,
          retryReads: true,
          w: 'majority',
          readPreference: 'primary',
        };
      },
    }),
    MongooseModule.forFeature(MODEL_DEFINITIONS),
  ],
  providers: DATABASE_SERVICES,
  exports: [MongooseModule, ...DATABASE_SERVICES],
})
export class DatabaseModule {}
