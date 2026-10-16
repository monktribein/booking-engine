import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf, ValidateNested } from 'class-validator';
import { Permission } from '../../../common/access/permissions';
import { PropertyAccess } from '../../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../../common/auth/auth-user';
import { CurrentUser, ReqMeta, RequireActiveOrg, Roles } from '../../../common/decorators';
import { ApiStandardErrors } from '../../../common/swagger';
import { ParseUuidPipe } from '../../../common/utils';
import { ProviderKind, ProviderStatus, ReconciliationIssueStatus, UserRole } from '../../../database/enums';
import { ProviderConnectionService } from './provider-connection.service';
import { ProviderService } from './provider.service';
import { ReconciliationService } from './reconciliation.service';

const onProperty = (p: Permission) => PropertyAccess(p, { in: 'param', key: 'propertyId', entity: 'property' });

class CredentialsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 4096) API_KEY?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 4096) BEARER_TOKEN?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 4096) BASIC_USERNAME?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 4096) BASIC_PASSWORD?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 4096) SIGNING_SECRET?: string;
  @ApiPropertyOptional({ description: 'The secret the provider signs its webhooks with' }) @IsOptional() @IsString() @Length(1, 4096) WEBHOOK_SECRET?: string;
}

class FeedDto {
  @ApiProperty({ example: 'Airbnb calendar' }) @IsString() @Length(1, 100) name!: string;
  @ApiProperty({ description: 'The calendar address. It works like a password: anyone with it can read the calendar.' }) @IsString() @Length(8, 1000) url!: string;
}

class ConnectProviderDto {
  @ApiPropertyOptional({ type: CredentialsDto, description: 'For API providers' }) @IsOptional() @ValidateNested() @Type(() => CredentialsDto) credentials?: CredentialsDto;
  @ApiPropertyOptional({ type: [FeedDto], description: 'For iCal providers: the calendars to read' }) @IsOptional() @ValidateNested({ each: true }) @Type(() => FeedDto) feeds?: FeedDto[];
  @ApiPropertyOptional({ enum: ['production', 'sandbox'] }) @IsOptional() @IsIn(['production', 'sandbox']) environment?: 'production' | 'sandbox';
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) externalAccountId?: string;
  @ApiPropertyOptional({ nullable: true, description: 'Seconds between reservation pulls (60-86400); null switches polling off' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(60)
  @Max(86_400)
  pollIntervalSeconds?: number | null;
}

class RotateCredentialsDto {
  @ApiPropertyOptional({ type: CredentialsDto }) @IsOptional() @ValidateNested() @Type(() => CredentialsDto) credentials?: CredentialsDto;
  @ApiPropertyOptional({ type: [FeedDto], description: 'iCal providers: the complete new list of calendars' }) @IsOptional() @ValidateNested({ each: true }) @Type(() => FeedDto) feeds?: FeedDto[];
}

class ConnectionSettingsDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(60) @Max(86_400) pollIntervalSeconds?: number | null;
  @ApiPropertyOptional({ enum: ['production', 'sandbox'] }) @IsOptional() @IsIn(['production', 'sandbox']) environment?: 'production' | 'sandbox';
}

/** What a partner sees: the providers it can connect, what each can do and what it needs. */
@ApiTags('Channels')
@Controller('channel-providers')
export class ProviderCatalogueController {
  constructor(private readonly providers: ProviderService) {}

  @Get()
  @Roles(UserRole.PROPERTY_OWNER, UserRole.PROPERTY_MANAGER, UserRole.SUPER_ADMIN, UserRole.OPERATIONS_ADMIN)
  @ApiOperation({ summary: 'Provider catalogue: protocol, capabilities, authentication and the credentials a connection needs' })
  @ApiStandardErrors()
  catalogue(@CurrentUser() user: AuthUser) {
    return this.providers.catalogue(user);
  }
}

/** Connections of one property to configuration-driven providers. */
@ApiTags('Channels')
@Controller('properties/:propertyId/channels/:channel')
export class ProviderConnectionsController {
  constructor(private readonly connections: ProviderConnectionService) {}

  @Get('connection')
  @onProperty(Permission.CHANNELS_VIEW)
  @ApiOperation({ summary: 'Connection details: status, environment, credentials that are stored (never their values), polling, webhook URL' })
  @ApiStandardErrors({ notFound: true })
  describe(@Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string) {
    return this.connections.describe(propertyId, channel);
  }

  @Post('credentials')
  @HttpCode(200)
  @RequireActiveOrg()
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Connect a property to a configured provider with credentials. Connected only if the provider accepts them.' })
  @ApiStandardErrors({ notFound: true })
  connect(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string, @Body() dto: ConnectProviderDto) {
    return this.connections.connect(user, meta, propertyId, channel, dto);
  }

  @Put('credentials')
  @RequireActiveOrg()
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Rotate credentials. The new ones are verified first; otherwise the old ones stay.' })
  @ApiStandardErrors({ notFound: true })
  rotate(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string, @Body() dto: RotateCredentialsDto) {
    return this.connections.rotate(user, meta, propertyId, channel, dto.credentials ?? {}, dto.feeds);
  }

  @Post('test')
  @HttpCode(200)
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Read-only health call with the stored credentials' })
  @ApiStandardErrors({ notFound: true })
  test(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string) {
    return this.connections.test(user, meta, propertyId, channel);
  }

  @Patch('settings')
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Polling interval and environment' })
  @ApiStandardErrors({ notFound: true })
  settings(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string, @Body() dto: ConnectionSettingsDto) {
    return this.connections.updateSettings(user, meta, propertyId, channel, dto);
  }
}

// ------------------------------------------------------------------ platform administration

class CreateProviderDto {
  @ApiProperty({ example: 'ACME_STAY' }) @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,31}$/) code!: string;
  @ApiProperty() @IsString() @Length(1, 100) name!: string;
  @ApiProperty({ enum: [ProviderKind.OTA, ProviderKind.PMS, ProviderKind.MARKETPLACE, ProviderKind.DIRECT] }) @IsIn([ProviderKind.OTA, ProviderKind.PMS, ProviderKind.MARKETPLACE, ProviderKind.DIRECT]) kind!: ProviderKind;
}

class VersionDto {
  @ApiProperty({ type: Object, description: 'The provider definition (see docs/CHANNEL_FRAMEWORK.md)' }) @IsObject() definition!: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 1000) notes?: string;
}

class ValidateDto {
  @ApiProperty({ type: Object }) @IsObject() definition!: Record<string, unknown>;
}

class DryRunDto {
  @ApiProperty({ enum: ['production', 'sandbox'] }) @IsIn(['production', 'sandbox']) environment!: 'production' | 'sandbox';
  @ApiProperty({ type: CredentialsDto, description: 'Used for this call only; never stored or logged' }) @ValidateNested() @Type(() => CredentialsDto) credentials!: CredentialsDto;
}

class RollbackDto {
  @ApiProperty() @IsString() @Length(36, 36) toVersionId!: string;
}

class ProviderStatusDto {
  @ApiProperty({ enum: [ProviderStatus.ACTIVE, ProviderStatus.DISABLED] }) @IsIn([ProviderStatus.ACTIVE, ProviderStatus.DISABLED]) status!: ProviderStatus.ACTIVE | ProviderStatus.DISABLED;
}

@ApiTags('Admin')
@Roles(UserRole.SUPER_ADMIN, UserRole.OPERATIONS_ADMIN)
@Controller('admin/channel-providers')
export class ProviderAdminController {
  constructor(private readonly providers: ProviderService) {}

  @Get()
  @ApiOperation({ summary: 'Every provider, built-in and configured' })
  list(@CurrentUser() user: AuthUser) {
    return this.providers.list(user);
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a provider (a draft until a version is published)' })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: CreateProviderDto) {
    return this.providers.create(user, meta, dto);
  }

  @Post('validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Validate a definition without storing it' })
  validate(@Body() dto: ValidateDto) {
    const r = this.providers.validate(dto.definition);
    return { ok: r.ok, errors: r.errors, warnings: r.warnings };
  }

  @Get(':id')
  @ApiOperation({ summary: 'A provider with its version history' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUuidPipe) id: string) {
    return this.providers.get(user, id);
  }

  @Post(':id/versions')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new draft version from a definition (validated on the way in)' })
  createVersion(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: VersionDto) {
    return this.providers.createVersion(user, meta, id, dto.definition, dto.notes);
  }

  @Get('versions/:versionId')
  @ApiOperation({ summary: 'One version including its definition and validation result' })
  async version(@CurrentUser() user: AuthUser, @Param('versionId', ParseUuidPipe) versionId: string) {
    const { version } = await this.providers.getVersion(user, versionId);
    return version;
  }

  @Put('versions/:versionId')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Edit a version that has not been published' })
  updateVersion(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('versionId', ParseUuidPipe) versionId: string, @Body() dto: ValidateDto) {
    return this.providers.updateDraft(user, meta, versionId, dto.definition);
  }

  @Get('versions/:versionId/diff/:otherId')
  @ApiOperation({ summary: 'Differences between two versions of a provider' })
  diff(@CurrentUser() user: AuthUser, @Param('versionId', ParseUuidPipe) a: string, @Param('otherId', ParseUuidPipe) b: string) {
    return this.providers.diff(user, a, b);
  }

  @Post('versions/:versionId/dry-run')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Read-only test of a version against the provider (credentials used for this call only)' })
  dryRun(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('versionId', ParseUuidPipe) versionId: string, @Body() dto: DryRunDto) {
    return this.providers.dryRun(user, meta, versionId, { environment: dto.environment, secrets: dto.credentials });
  }

  @Post('versions/:versionId/publish')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Publish a validated version: it becomes the version new connections use. Published versions are immutable.' })
  publish(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('versionId', ParseUuidPipe) versionId: string) {
    return this.providers.publish(user, meta, versionId);
  }

  @Post(':id/rollback')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Publish a copy of an earlier version as the newest version' })
  rollback(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: RollbackDto) {
    return this.providers.rollback(user, meta, id, dto.toVersionId);
  }

  @Patch(':id/status')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Enable or disable a provider (disabling stops new connections and all use of its definition)' })
  status(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: ProviderStatusDto) {
    return this.providers.setStatus(user, meta, id, dto.status);
  }
}

// ------------------------------------------------------------------ reconciliation

class ResolveIssueDto {
  @ApiProperty({ enum: [ReconciliationIssueStatus.RESOLVED, ReconciliationIssueStatus.IGNORED] }) @IsIn([ReconciliationIssueStatus.RESOLVED, ReconciliationIssueStatus.IGNORED]) status!: ReconciliationIssueStatus.RESOLVED | ReconciliationIssueStatus.IGNORED;
  @ApiProperty({ description: 'What was done, for the record' }) @IsString() @Length(1, 500) resolution!: string;
}

/** Differences between a provider and Tirvona, found by comparison and kept for staff to resolve. */
@ApiTags('Channels')
@Controller('properties/:propertyId/channels/:channel/reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  @onProperty(Permission.CHANNELS_VIEW)
  @ApiOperation({ summary: 'Recent reconciliation runs and the open issues' })
  @ApiStandardErrors({ notFound: true })
  list(@Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string) {
    return this.reconciliation.list(propertyId, channel);
  }

  @Post()
  @HttpCode(200)
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Compare now. Missing reservations are imported through the normal pipeline; nothing is ever cancelled or overwritten.' })
  @ApiStandardErrors({ notFound: true })
  run(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('channel') channel: string) {
    return this.reconciliation.run(propertyId, channel, { user, meta });
  }

  @Post('issues/:issueId')
  @HttpCode(200)
  @onProperty(Permission.CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Mark an issue resolved or ignored, with a note' })
  @ApiStandardErrors({ notFound: true })
  resolve(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseUuidPipe) propertyId: string, @Param('issueId', ParseUuidPipe) issueId: string, @Body() dto: ResolveIssueDto) {
    return this.reconciliation.resolve(user, meta, propertyId, issueId, dto.status, dto.resolution);
  }
}
