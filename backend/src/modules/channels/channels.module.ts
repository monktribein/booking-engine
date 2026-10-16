import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, Public, ReqMeta } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import type { AppConfig } from '../../config/configuration';
import { ChannelCode } from '../../database/enums';
import { DomainError } from '../../database/errors';
import { AgodaAdapter } from './agoda/agoda.adapter';
import { AirbnbAdapter } from './airbnb/airbnb.adapter';
import { BookingComAdapter } from './booking-com/booking-com.adapter';
import { ChannelAdapterRegistry } from './channel-registry';
import {
  ChannelStatusDto,
  ConnectResultDto,
  CreateMappingsDto,
  ListingWithMappingsDto,
  MappingResultDto,
  SyncTriggerResultDto,
} from './channels.dto';
import { ChannelsService } from './channels.service';
import { ConnectionSecretsService } from './providers/connection-secrets.service';
import { ProviderConnectionService } from './providers/provider-connection.service';
import { ProviderService } from './providers/provider.service';
import { ProviderAdminController, ProviderCatalogueController, ProviderConnectionsController, ReconciliationController } from './providers/providers.controller';
import { IcalExportService, IcalFeedsController, IcalPublicController } from './providers/ical-export';
import { ReconciliationService } from './providers/reconciliation.service';
import { MOCK_AUTH_CODE, MockChannelAdapter, MockChannelStore } from './mock/mock-channel.adapter';

const CHANNEL_PARAM = { name: 'channel', enum: [ChannelCode.AIRBNB, ChannelCode.BOOKING_COM, ChannelCode.AGODA, ChannelCode.MOCK] };
const onProperty = (p: Permission) => PropertyAccess(p, { in: 'param', key: 'propertyId', entity: 'property' });

@ApiTags('Channels')
@Controller('properties/:propertyId/channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @onProperty(Permission.CHANNELS_VIEW)
  @ApiOperation({ summary: 'Connection status of every channel (internal TIRVONA/DIRECT and external OTAs)' })
  @ApiEnvelope(ChannelStatusDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  list(@Param('propertyId', ParseUuidPipe) propertyId: string) {
    return this.channels.listChannels(propertyId);
  }

  @Post(':channel/connect')
  @HttpCode(200)
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiParam(CHANNEL_PARAM)
  @ApiOperation({ summary: "Start the channel's official authorization flow; redirect the owner to authorizationUrl" })
  @ApiEnvelope(ConnectResultDto)
  @ApiStandardErrors({ notFound: true })
  connect(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string) {
    return this.channels.connect(user, meta, propertyId, channel);
  }

  @Post(':channel/disconnect')
  @HttpCode(200)
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiParam(CHANNEL_PARAM)
  @ApiOperation({ summary: 'Disconnect: revoke remotely (best effort) and wipe stored credentials' })
  @ApiEnvelope(ConnectResultDto)
  @ApiStandardErrors({ notFound: true })
  disconnect(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string) {
    return this.channels.disconnect(user, meta, propertyId, channel);
  }

  @Get(':channel/listings')
  @onProperty(Permission.CHANNELS_VIEW)
  @ApiParam(CHANNEL_PARAM)
  @ApiQuery({ name: 'refresh', required: false, description: 'false = use cached listings (default true)' })
  @ApiOperation({ summary: 'External listings with their rooms/rate plans and current mappings' })
  @ApiEnvelope(ListingWithMappingsDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  listings(@Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string, @Query('refresh') refresh?: string) {
    return this.channels.getListings(propertyId, channel, refresh !== 'false');
  }

  @Post(':channel/mappings')
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiParam(CHANNEL_PARAM)
  @ApiOperation({ summary: 'Map listings/rooms to room types and external rate plans to rate plans (idempotent); queues a full push' })
  @ApiEnvelope(MappingResultDto, { status: 201, isArray: true })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE (already mapped to another room type)' })
  map(
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
    @Param('propertyId', ParseUuidPipe) propertyId: string,
    @Param('channel') channel: string,
    @Body() dto: CreateMappingsDto,
  ) {
    return this.channels.createMappings(user, meta, propertyId, channel, dto);
  }

  @Delete(':channel/mappings/:mappingId')
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiParam(CHANNEL_PARAM)
  @ApiOperation({ summary: 'Remove a mapping (stops syncing that listing/room)' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  unmap(
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
    @Param('propertyId', ParseUuidPipe) propertyId: string,
    @Param('mappingId', ParseUuidPipe) mappingId: string,
  ) {
    return this.channels.removeMapping(user, meta, propertyId, mappingId);
  }

  @Post(':channel/sync')
  @HttpCode(202)
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiParam(CHANNEL_PARAM)
  @ApiOperation({ summary: 'Manual full resync (availability, rates, restrictions) via the sync queues' })
  @ApiEnvelope(SyncTriggerResultDto, { status: 202 })
  @ApiStandardErrors({ notFound: true })
  sync(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string) {
    return this.channels.triggerSync(user, meta, propertyId, channel);
  }
}

/** Browser-facing endpoints of the authorization flow. They return redirects, not JSON. */
@ApiTags('Channels')
@Controller('channels')
export class ChannelOAuthController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Public()
  @Get('oauth/:channel/callback')
  @ApiOperation({ summary: 'OAuth redirect target registered with each channel. Redirects back to the Tirvona app.' })
  async callback(@Param('channel') channel: string, @Query() query: Record<string, string>, @Res() res: Response) {
    const app = this.config.get('appUrl', { infer: true });
    try {
      const { propertyId } = await this.channels.completeAuthorization(channel, query);
      res.redirect(302, `${app}/properties/${propertyId}/channels?connected=${encodeURIComponent(channel)}`);
    } catch (err) {
      const code = err instanceof DomainError ? err.code : 'INTERNAL_ERROR';
      res.redirect(302, `${app}/channels/connect-error?channel=${encodeURIComponent(channel)}&code=${encodeURIComponent(code)}`);
    }
  }

  /** The mock OTA's "consent screen": approves immediately. Only exists when the mock channel is enabled. */
  @Public()
  @Get('MOCK/mock-authorize')
  @ApiExcludeEndpoint()
  mockAuthorize(@Query('state') state: string, @Query('redirect_uri') redirectUri: string, @Res() res: Response) {
    if (!this.config.get('mockChannel', { infer: true }).enabled) throw new DomainError('NOT_FOUND', 'Not found');
    // Only redirect back to our own callback (no open redirect).
    if (redirectUri !== this.channels.callbackUrl(ChannelCode.MOCK)) throw new DomainError('VALIDATION_ERROR', 'Unexpected redirect_uri');
    const target = new URL(redirectUri);
    target.searchParams.set('code', MOCK_AUTH_CODE);
    target.searchParams.set('state', state);
    res.redirect(302, target.toString());
  }
}

@Module({
  controllers: [ChannelsController, ChannelOAuthController, ProviderCatalogueController, ProviderConnectionsController, ProviderAdminController, ReconciliationController, IcalFeedsController, IcalPublicController],
  providers: [ChannelsService, ChannelAdapterRegistry, AirbnbAdapter, BookingComAdapter, AgodaAdapter, MockChannelAdapter, MockChannelStore, ConnectionSecretsService, ProviderService, ProviderConnectionService, ReconciliationService, IcalExportService],
  exports: [ChannelsService, ChannelAdapterRegistry, MockChannelAdapter, MockChannelStore, ConnectionSecretsService, ProviderService, ProviderConnectionService, ReconciliationService],
})
export class ChannelsModule {}
