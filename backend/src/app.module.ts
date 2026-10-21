import { Controller, Get, Global, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, ThrottlerModule } from '@nestjs/throttler';
import { ClientIpThrottlerGuard } from './common/client-ip';
import { sql } from 'kysely';
import { PropertyAccessGuard } from './common/access/property-access.guard';
import { PropertyAccessService } from './common/access/property-access.service';
import { Public } from './common/decorators';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RedisThrottlerStorage } from './common/redis';
import configuration, { AppConfig } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { Db, InjectDb } from './database/kysely';
import { JobsModule } from './jobs/jobs.module';
import { JobsProducer } from './jobs/jobs.producer';
import { SchedulerModule } from './jobs/scheduler.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.logger';
import { AuthModule } from './modules/auth/auth.module';
import { BookingEngineModule } from './modules/booking-engine/booking-engine.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { IntegrationRequestsModule } from './modules/channels/integration-requests';
import { GuestsModule } from './modules/guests/guests.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PropertiesModule } from './modules/properties/properties.module';
import { PublicApiModule } from './modules/public-api/public-api.module';
import { RatesModule } from './modules/rates/rates.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RetentionModule } from './modules/retention/retention.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { RoomTypesModule } from './modules/room-types/room-types.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { SyncModule } from './modules/sync/sync.module';
import { UsersModule } from './modules/users/users.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

/** Cross-cutting providers every module may inject. */
@Global()
@Module({ providers: [PropertyAccessService], exports: [PropertyAccessService] })
class CommonModule {}

@ApiTags('Health')
@Controller('health')
class HealthController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly jobs: JobsProducer,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({ summary: 'Readiness: PostgreSQL and the job queue backend are reachable (503 otherwise)' })
  async health() {
    const withTimeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    const [database, queues] = await Promise.allSettled([withTimeout(sql`select 1`.execute(this.db)), withTimeout(this.jobs.stats())]);
    const body = {
      status: database.status === 'fulfilled' && queues.status === 'fulfilled' ? 'ok' : 'degraded',
      database: database.status === 'fulfilled' ? 'up' : 'down',
      queues: queues.status === 'fulfilled' ? 'up' : 'down',
      uptimeSeconds: Math.round(process.uptime()),
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE', message: 'Dependency unavailable', details: body });
    return body;
  }
}

// Evaluated after ConfigModule.forRoot has loaded .env (imports are built in order).
const configModule = ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv, cache: true });
const boot = configuration();

@Module({
  imports: [
    configModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const t = config.get('throttle', { infer: true });
        const q = config.get('queue', { infer: true });
        const redisUrl = config.get('redis', { infer: true }).url;
        return {
          throttlers: [{ name: 'default', ttl: t.ttlMs, limit: t.limit }],
          // Shared counters across API instances in production; in-memory for tests.
          storage: q.driver === 'bullmq' && redisUrl ? new RedisThrottlerStorage(redisUrl, config.get('queue', { infer: true }).prefix) : undefined,
        };
      },
    }),
    DatabaseModule,
    JobsModule.forRoot({ driver: boot.queue.driver, redisUrl: boot.redis.url, workersEnabled: boot.queue.workersEnabled, prefix: boot.queue.prefix, backoffOverrideMs: boot.queue.backoffOverrideMs }),
    CommonModule,
    AuditModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    PropertiesModule,
    RoomTypesModule,
    RoomsModule,
    RatesModule,
    InventoryModule,
    GuestsModule,
    ReservationsModule,
    PaymentsModule,
    BookingEngineModule,
    PublicApiModule,
    ChannelsModule,
    IntegrationRequestsModule,
    WebhooksModule,
    SyncModule,
    NotificationsModule,
    ReportsModule,
    RetentionModule,
    AdminModule,
    SchedulerModule,
  ],
  controllers: [HealthController],
  providers: [
    // Guard order: rate limit → authenticate → org role → property membership/permission.
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PropertyAccessGuard },
  ],
})
export class AppModule {}
