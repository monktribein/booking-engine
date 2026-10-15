import { Body, Controller, HttpCode, Module, Param, Post, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Max, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import { Public } from '../../common/decorators';
import { IsDateOnly } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { eachNight, toDateOnly } from '../../database/common/dates';
import { DomainError } from '../../database/errors';
import { ChannelsModule } from '../channels/channels.module';
import { MockChannelAdapter, MockChannelStore } from '../channels/mock/mock-channel.adapter';
import { WebhookJobHandler, WebhooksService } from './webhooks.service';

class WebhookReceiptDto {
  @ApiProperty() received!: boolean;
  @ApiProperty({ description: 'True when this event id was already received (nothing is processed twice)' }) duplicate!: boolean;
  @ApiProperty() eventId!: string;
}

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post(':channel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Inbound OTA webhook',
    description:
      'Verifies the signature over the raw body, stores the raw event (idempotent on channel + event id), enqueues processing and returns immediately. Invalid signatures get 401 (the event is kept as IGNORED).',
  })
  @ApiBody({ schema: { type: 'object', description: 'Channel-specific payload' } })
  @ApiEnvelope(WebhookReceiptDto)
  @ApiStandardErrors({ auth: false, notFound: true })
  receive(@Param('channel') channel: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.webhooks.receive(channel.toUpperCase(), {
      headers: req.headers,
      rawBody: req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})),
      body: req.body,
    });
  }
}

// ------------------------------------------------------------------ mock channel simulation

class SimulateReservationDto {
  @ApiProperty({ enum: ['created', 'modified', 'cancelled'] }) @IsIn(['created', 'modified', 'cancelled']) action!: 'created' | 'modified' | 'cancelled';
  @ApiPropertyOptional({ description: 'Defaults to a new random id (for created)' }) @IsOptional() @IsString() @Length(3, 60) externalReservationId?: string;
  @ApiProperty({ example: 'MOCK-HOTEL-1' }) @IsString() externalListingId!: string;
  @ApiPropertyOptional({ nullable: true, example: 'MOCK-ROOM-DLX' }) @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() externalRoomId?: string | null;
  @ApiPropertyOptional({ example: 'MOCK-ROOM-DLX-FLEX' }) @IsOptional() @IsString() externalRatePlanId?: string;
  @ApiProperty({ example: '2026-10-05' }) @IsDateOnly() checkIn!: string;
  @ApiProperty({ example: '2026-10-07' }) @IsDateOnly() checkOut!: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) quantity?: number;
  @ApiPropertyOptional({ default: 400000, description: 'Per-night price, minor units' }) @IsOptional() @IsInt() @Min(0) nightlyRate?: number;
  @ApiPropertyOptional({ default: 'Mock' }) @IsOptional() @IsString() guestFirstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() guestEmail?: string;
}

class SimulateFailuresDto {
  @ApiProperty({ description: 'Number of upcoming push calls to the mock OTA that should fail' }) @IsInt() @Min(0) @Max(1000) count!: number;
}

/**
 * Dev/test tooling: makes the mock OTA send a correctly signed webhook
 * through the real inbound pipeline, or fail its next N pushes. Refused
 * unless MOCK_CHANNEL_ENABLED (never in production).
 */
@ApiTags('Mock channel (dev/test)')
@Controller('properties/:propertyId/channels/MOCK/simulate')
export class MockChannelSimulationController {
  constructor(
    private readonly mock: MockChannelAdapter,
    private readonly store: MockChannelStore,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post('reservation')
  @HttpCode(200)
  @PropertyAccess(Permission.CHANNELS_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Simulate the mock OTA sending a reservation created/modified/cancelled webhook' })
  @ApiEnvelope(WebhookReceiptDto)
  @ApiStandardErrors({ notFound: true })
  simulateReservation(@Param('propertyId', ParseUuidPipe) _propertyId: string, @Body() dto: SimulateReservationDto) {
    this.assertEnabled();
    const externalReservationId = dto.externalReservationId ?? `MOCKRES-${randomBytes(4).toString('hex').toUpperCase()}`;
    const nights = eachNight(toDateOnly(dto.checkIn), toDateOnly(dto.checkOut)).length;
    const built = this.mock.buildWebhook({
      eventId: `evt_${randomBytes(8).toString('hex')}`,
      type: `reservation.${dto.action}`,
      reservation: {
        externalListingId: dto.externalListingId,
        externalReservationId,
        checkIn: dto.checkIn,
        checkOut: dto.checkOut,
        adults: 2,
        guest: { firstName: dto.guestFirstName ?? 'Mock', lastName: 'Guest', email: dto.guestEmail },
        rooms: [
          {
            externalRoomId: dto.externalRoomId ?? null,
            externalRatePlanId: dto.externalRatePlanId,
            quantity: dto.quantity ?? 1,
            nightlyRates: Array.from({ length: nights }, () => dto.nightlyRate ?? 400000),
          },
        ],
        currency: 'INR',
        paymentCollectedByChannel: true,
      },
    });
    return this.webhooks.receive('MOCK', { headers: built.headers, rawBody: built.rawBody, body: built.body });
  }

  @Post('failures')
  @HttpCode(200)
  @PropertyAccess(Permission.CHANNELS_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Make the next N pushes to the mock OTA fail (tests retries and failure handling)' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  simulateFailures(@Param('propertyId', ParseUuidPipe) _propertyId: string, @Body() dto: SimulateFailuresDto) {
    this.assertEnabled();
    this.store.failNextPushes(dto.count);
    return { ok: true };
  }

  private assertEnabled() {
    if (!this.mock.isAvailable()) throw new DomainError('NOT_FOUND', 'Mock channel is disabled');
  }
}

@Module({
  imports: [ChannelsModule],
  controllers: [WebhooksController, MockChannelSimulationController],
  providers: [WebhooksService, WebhookJobHandler],
  exports: [WebhooksService, WebhookJobHandler],
})
export class WebhooksModule {}
