import { Module } from '@nestjs/common';
import { BookingEngineModule } from '../booking-engine/booking-engine.module';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeyService } from './api-key.service';
import { ClientWebhookJobHandler } from './client-webhook.handler';
import { ApiKeysController, WebhookEndpointsController } from './developer.controller';
import { PublicApiV1Controller } from './v1.controller';
import { PublicApiV1Service } from './v1.service';
import { WebhookEndpointsService } from './webhook-endpoints.service';

/**
 * The versioned public API (/v1) for external clients, plus the dashboard endpoints that manage API keys and
 * webhook endpoints, and the worker that delivers signed webhooks.
 */
@Module({
  imports: [BookingEngineModule],
  controllers: [PublicApiV1Controller, ApiKeysController, WebhookEndpointsController],
  providers: [ApiKeyService, ApiKeyGuard, PublicApiV1Service, WebhookEndpointsService, ClientWebhookJobHandler],
})
export class PublicApiModule {}
