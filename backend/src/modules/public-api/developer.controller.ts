import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, Max, Min, IsDate, IsEnum, IsIn, IsUUID, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, RequireActiveOrg, Roles } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { API_EVENT_TYPES, API_SCOPES, UserRole, WebhookDeliveryStatus, WebhookEndpointStatus } from '../../database/enums';
import { sql } from 'kysely';
import { Db, InjectDb } from '../../database/kysely';
import { ApiKeyService } from './api-key.service';
import { ApiUsageService } from './api-usage.service';
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
  @IsUUID(undefined, { each: true })
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
  @ApiPropertyOptional({ nullable: true, description: 'Address of the last request made with this key' }) lastUsedIp!: string | null;
  @ApiProperty({ example: 'production', description: 'The deployment environment the key was issued in' }) environment!: string;
  @ApiPropertyOptional({ nullable: true, description: 'The key this one replaced (rotation)' }) rotatedFrom!: string | null;
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
  @ApiPropertyOptional({ description: 'Include guest e-mail, phone and special requests in payloads (default false: first name and last initial only)' }) @IsOptional() @IsBoolean() includeGuestDetails?: boolean;
  @ApiPropertyOptional({ description: 'Only events of these properties. Omit for all properties of the organization.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  propertyIds?: string[];
}

export class RotateApiKeyDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 72, description: 'Keep the old key valid for this many hours. Omit to revoke it immediately.' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(72) graceHours?: number;
}

export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({ description: 'Include guest e-mail, phone and special requests in payloads' }) @IsOptional() @IsBoolean() includeGuestDetails?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsString({ each: true }) events?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) propertyIds?: string[];
  @ApiPropertyOptional({ enum: WebhookEndpointStatus }) @IsOptional() @IsEnum(WebhookEndpointStatus) status?: WebhookEndpointStatus;
}

export class WebhookEndpointDto {
  @ApiProperty() _id!: string;
  @ApiProperty() url!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ type: [String] }) events!: string[];
  @ApiProperty({ type: [String] }) propertyIds!: string[];
  @ApiProperty({ enum: WebhookEndpointStatus }) status!: WebhookEndpointStatus;
  @ApiProperty({ description: 'false = payloads carry the guest as first name + last initial only' }) includeGuestDetails!: boolean;
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
@Roles(UserRole.PROPERTY_OWNER, UserRole.DEVELOPER)
@Controller('api-keys')
export class ApiKeysController {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly usageService: ApiUsageService,
  ) {}

  @Post()
  @RequireActiveOrg()
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

  @Get(':id')
  @ApiOperation({ summary: 'One API key (never the secret)' })
  @ApiEnvelope(ApiKeyDto)
  @ApiStandardErrors({ notFound: true })
  getOne(@CurrentUser() user: AuthUser, @Param('id', ParseUuidPipe) id: string) {
    return this.keys.get(user, id);
  }

  @Post(':id/rotate')
  @HttpCode(200)
  @RequireActiveOrg()
  @ApiOperation({
    summary: 'Rotate an API key: issue a replacement with the same scopes and restrictions',
    description: 'The new secret is returned once. By default the old key stops working immediately; pass graceHours (1-72) to let it keep working until then so you can deploy the new key without downtime.',
  })
  @ApiEnvelope(CreatedApiKeyDto)
  @ApiStandardErrors({ notFound: true })
  rotate(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: RotateApiKeyDto) {
    return this.keys.rotate(user, meta, id, dto.graceHours ?? 0);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Requests and errors per day for one key (last 30 days)' })
  @ApiStandardErrors({ notFound: true })
  async usage(@CurrentUser() user: AuthUser, @Param('id', ParseUuidPipe) id: string) {
    await this.keys.get(user, id); // ownership check: another organization's key is a 404
    return { days: await this.usageService.forKey(id, 30) };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke an API key. Takes effect immediately and cannot be undone.' })
  @ApiEnvelope(ApiKeyDto)
  @ApiStandardErrors({ notFound: true })
  revoke(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.keys.revoke(user, meta, id);
  }
}

@ApiTags('Developer: Webhooks')
@Roles(UserRole.PROPERTY_OWNER, UserRole.DEVELOPER)
@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointsService) {}

  @Post()
  @RequireActiveOrg()
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
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: UpdateWebhookEndpointDto) {
    return this.endpoints.update(user, meta, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an endpoint and its delivery history' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  remove(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.endpoints.remove(user, meta, id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a new signing secret. The old one stops working immediately.' })
  @ApiEnvelope(CreatedWebhookEndpointDto)
  @ApiStandardErrors({ notFound: true })
  rotate(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.endpoints.rotateSecret(user, meta, id);
  }

  @Post(':id/test')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a signed `ping` event to verify the receiver' })
  @ApiStandardErrors({ notFound: true })
  test(@CurrentUser() user: AuthUser, @Param('id', ParseUuidPipe) id: string) {
    return this.endpoints.sendTest(user, id);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Delivery attempts and outcomes for an endpoint, newest first' })
  @ApiEnvelope(WebhookDeliveryDto, { paginated: true })
  @ApiStandardErrors({ notFound: true })
  deliveries(@CurrentUser() user: AuthUser, @Param('id', ParseUuidPipe) id: string, @Query() q: DeliveriesQueryDto) {
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
    @Param('id', ParseUuidPipe) id: string,
    @Param('deliveryId', ParseUuidPipe) deliveryId: string,
  ) {
    return this.endpoints.redeliver(user, meta, id, deliveryId);
  }
}

// ------------------------------------------------------------------ overview + helpers for the developer portal

@ApiTags('Developer: Overview')
@Roles(UserRole.PROPERTY_OWNER, UserRole.DEVELOPER)
@Controller('developer')
export class DeveloperController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly usage: ApiUsageService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Integration health: keys, endpoints, delivery outcomes and API errors',
    description: 'Real counts from this organization only. Nothing here is estimated or sample data.',
  })
  @ApiStandardErrors()
  async overview(@CurrentUser() user: AuthUser) {
    const organizationId = user.organizationId ?? '00000000-0000-0000-0000-000000000000';
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [keys, endpoints, deliveries, failing, usage7d] = await Promise.all([
      this.db.selectFrom('apiKeys').select([sql<number>`count(*) filter (where status = 'ACTIVE')::int`.as('active'), sql<number>`count(*) filter (where status = 'REVOKED')::int`.as('revoked')]).where('organizationId', '=', organizationId).executeTakeFirstOrThrow(),
      this.db.selectFrom('webhookEndpoints').select([sql<number>`count(*) filter (where status = 'ACTIVE')::int`.as('active'), sql<number>`count(*) filter (where status = 'DISABLED')::int`.as('disabled')]).where('organizationId', '=', organizationId).executeTakeFirstOrThrow(),
      this.db
        .selectFrom('webhookDeliveries')
        .select(['status', sql<number>`count(*)::int`.as('n')])
        .where('organizationId', '=', organizationId)
        .where('createdAt', '>=', since)
        .groupBy('status')
        .execute(),
      // Endpoints whose most recent delivery failed: the ones to look at first.
      this.db
        .selectFrom('webhookEndpoints as e')
        .innerJoin('webhookDeliveries as w', (j) => j.onRef('w.endpointId', '=', 'e.id'))
        .select(['e.id', 'e.url', sql<number>`count(*) filter (where w.status = 'FAILED')::int`.as('failed'), sql<string | null>`max(w.last_error) filter (where w.status in ('FAILED','RETRYING'))`.as('lastError')])
        .where('e.organizationId', '=', organizationId)
        .where('w.createdAt', '>=', since)
        .groupBy(['e.id', 'e.url'])
        .having(sql<boolean>`count(*) filter (where w.status in ('FAILED','RETRYING')) > 0`)
        .execute(),
      this.usage.forOrganization(organizationId, 7),
    ]);
    const by = Object.fromEntries(deliveries.map((x) => [x.status, x.n])) as Record<string, number>;
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    return {
      apiKeys: keys,
      webhookEndpoints: endpoints,
      deliveriesLast24h: { total, delivered: by.DELIVERED ?? 0, pending: (by.PENDING ?? 0) + (by.RETRYING ?? 0), failed: by.FAILED ?? 0 },
      endpointsWithProblems: failing.map((f) => ({ endpointId: f.id, url: f.url, failedLast24h: f.failed, lastError: f.lastError })),
      apiUsageLast7Days: usage7d,
    };
  }

  @Get('properties')
  @ApiOperation({ summary: "The organization's properties (id, name, slug), to scope keys and webhook endpoints. No guest or booking data." })
  @ApiStandardErrors()
  properties(@CurrentUser() user: AuthUser) {
    return this.db
      .selectFrom('properties')
      .select(['id', 'name', 'slug', 'status'])
      .where('organizationId', '=', user.organizationId ?? '00000000-0000-0000-0000-000000000000')
      .where('status', '<>', 'ARCHIVED')
      .orderBy('name')
      .execute();
  }
}
