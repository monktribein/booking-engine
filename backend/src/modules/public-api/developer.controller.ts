import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDate, IsEnum, IsIn, IsMongoId, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, Roles } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseObjectIdPipe } from '../../common/utils';
import { API_EVENT_TYPES, API_SCOPES, UserRole, WebhookDeliveryStatus, WebhookEndpointStatus } from '../../database/enums';
import { ApiKeyService } from './api-key.service';
import { WebhookEndpointsService } from './webhook-endpoints.service';

// ------------------------------------------------------------------ DTOs

export class CreateApiKeyDto {
  @ApiProperty({ example: 'Tirvona marketplace' }) @IsString() @Length(2, 100) name!: string;
  @ApiProperty({ enum: API_SCOPES, isArray: true, example: ['availability:read', 'reservations:write'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(API_SCOPES.length)
  @IsIn(API_SCOPES, { each: true })
  scopes!: string[];
  @ApiPropertyOptional({ description: 'Restrict the key to these properties. Omit for every property of the organization.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  propertyIds?: string[];
  @ApiPropertyOptional({ description: 'ISO 8601. Omit for a key that does not expire.' }) @IsOptional() @Type(() => Date) @IsDate() expiresAt?: Date;
}

export class ApiKeyDto {
  @ApiProperty() _id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: 'tvk_ab12cd34_' }) keyPrefix!: string;
  @ApiProperty({ enum: API_SCOPES, isArray: true }) scopes!: string[];
  @ApiProperty({ type: [String] }) propertyIds!: string[];
  @ApiProperty({ enum: ['ACTIVE', 'REVOKED'] }) status!: string;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) lastUsedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreatedApiKeyDto extends ApiKeyDto {
  @ApiProperty({ description: 'The full API key. Shown ONCE; store it securely. Only a hash is kept.', example: 'tvk_ab12cd34_...' }) key!: string;
}

export class CreateWebhookEndpointDto {
  @ApiProperty({ example: 'https://api.example.com/tirvona/webhooks' }) @IsString() @MaxLength(2000) url!: string;
  @ApiProperty({ example: ['reservation.confirmed', 'reservation.cancelled'], description: `One or more of: ${API_EVENT_TYPES.filter((t) => t !== 'ping').join(', ')}, or "*"` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @IsString({ each: true })
  events!: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional({ description: 'Only events of these properties. Omit for all properties of the organization.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  propertyIds?: string[];
}

export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsString({ each: true }) events?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(100) @IsMongoId({ each: true }) propertyIds?: string[];
  @ApiPropertyOptional({ enum: WebhookEndpointStatus }) @IsOptional() @IsEnum(WebhookEndpointStatus) status?: WebhookEndpointStatus;
}

export class WebhookEndpointDto {
  @ApiProperty() _id!: string;
  @ApiProperty() url!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ type: [String] }) events!: string[];
  @ApiProperty({ type: [String] }) propertyIds!: string[];
  @ApiProperty({ enum: WebhookEndpointStatus }) status!: WebhookEndpointStatus;
  @ApiProperty() createdAt!: string;
}

export class CreatedWebhookEndpointDto extends WebhookEndpointDto {
  @ApiProperty({ description: 'Signing secret (whsec_...). Shown ONCE, at creation and after rotation.' }) secret!: string;
}

export class DeliveriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WebhookDeliveryStatus }) @IsOptional() @IsEnum(WebhookDeliveryStatus) status?: WebhookDeliveryStatus;
}

export class WebhookDeliveryDto {
  @ApiProperty() _id!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty() eventType!: string;
  @ApiProperty({ enum: WebhookDeliveryStatus }) status!: WebhookDeliveryStatus;
  @ApiProperty() attempts!: number;
  @ApiPropertyOptional() lastStatusCode?: number;
  @ApiPropertyOptional() lastError?: string;
  @ApiPropertyOptional() deliveredAt?: string;
  @ApiProperty() createdAt!: string;
}

// ------------------------------------------------------------------ controllers (dashboard, signed-in organization owners)

@ApiTags('Developer: API keys')
@Roles(UserRole.PROPERTY_OWNER)
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  @Post()
  @ApiOperation({ summary: 'Create an API key for the public API (/v1). The key is returned once.' })
  @ApiEnvelope(CreatedApiKeyDto, { status: 201 })
  @ApiStandardErrors()
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: CreateApiKeyDto) {
    return this.keys.create(user, meta, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the organization\'s API keys (never the secrets)' })
  @ApiEnvelope(ApiKeyDto, { isArray: true })
  @ApiStandardErrors()
  list(@CurrentUser() user: AuthUser) {
    return this.keys.list(user);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke an API key. Takes effect immediately and cannot be undone.' })
  @ApiEnvelope(ApiKeyDto)
  @ApiStandardErrors({ notFound: true })
  revoke(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.keys.revoke(user, meta, id);
  }
}

@ApiTags('Developer: Webhooks')
@Roles(UserRole.PROPERTY_OWNER)
@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointsService) {}

  @Post()
  @ApiOperation({ summary: 'Register a webhook endpoint. The signing secret is returned once.' })
  @ApiEnvelope(CreatedWebhookEndpointDto, { status: 201 })
  @ApiStandardErrors()
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: CreateWebhookEndpointDto) {
    return this.endpoints.create(user, meta, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List webhook endpoints' })
  @ApiEnvelope(WebhookEndpointDto, { isArray: true })
  @ApiStandardErrors()
  list(@CurrentUser() user: AuthUser) {
    return this.endpoints.list(user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change URL, events, properties or status (ACTIVE / DISABLED)' })
  @ApiEnvelope(WebhookEndpointDto)
  @ApiStandardErrors({ notFound: true })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateWebhookEndpointDto) {
    return this.endpoints.update(user, meta, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an endpoint and its delivery history' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  remove(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.endpoints.remove(user, meta, id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a new signing secret. The old one stops working immediately.' })
  @ApiEnvelope(CreatedWebhookEndpointDto)
  @ApiStandardErrors({ notFound: true })
  rotate(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.endpoints.rotateSecret(user, meta, id);
  }

  @Post(':id/test')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a signed `ping` event to verify the receiver' })
  @ApiStandardErrors({ notFound: true })
  test(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.endpoints.sendTest(user, id);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Delivery attempts and outcomes for an endpoint, newest first' })
  @ApiEnvelope(WebhookDeliveryDto, { paginated: true })
  @ApiStandardErrors({ notFound: true })
  deliveries(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Query() q: DeliveriesQueryDto) {
    return this.endpoints.deliveries(user, id, q);
  }

  @Post(':id/deliveries/:deliveryId/redeliver')
  @HttpCode(202)
  @ApiOperation({ summary: 'Retry a failed delivery (same event id and body)' })
  @ApiEnvelope(WebhookDeliveryDto, { status: 202 })
  @ApiStandardErrors({ notFound: true })
  redeliver(
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Param('deliveryId', ParseObjectIdPipe) deliveryId: Types.ObjectId,
  ) {
    return this.endpoints.redeliver(user, meta, id, deliveryId);
  }
}
