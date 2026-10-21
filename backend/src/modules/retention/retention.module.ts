import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Module, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, RequireActiveOrg, Roles } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { UserRole } from '../../database/enums';
import { DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { runRetention } from '../../database/services/retention';
import { AuditLogger } from '../audit/audit.logger';

export class RetentionPolicyInputDto {
  @ApiPropertyOptional({ nullable: true, example: 730, description: 'Anonymise a guest this many days after their last stay ended. null = never.' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(30)
  @Max(3650)
  guestAnonymizeAfterDays?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 90, description: 'Blank the recipient, subject and body of sent / failed messages after this many days. null = never.' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(7)
  @Max(3650)
  notificationRedactAfterDays?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 90, description: 'Replace the raw payload of processed inbound channel (OTA) events with a marker after this many days. null = never.' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(7)
  @Max(3650)
  inboundPayloadRedactAfterDays?: number | null;
}

export class RetentionRunDto {
  @ApiProperty({ example: 'ANONYMIZE', description: 'Must be exactly ANONYMIZE: this permanently removes personal data' })
  @IsIn(['ANONYMIZE'])
  confirm!: string;
}

class PolicyView {
  @ApiPropertyOptional({ nullable: true }) guestAnonymizeAfterDays!: number | null;
  @ApiPropertyOptional({ nullable: true }) notificationRedactAfterDays!: number | null;
  @ApiPropertyOptional({ nullable: true }) inboundPayloadRedactAfterDays!: number | null;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ nullable: true }) approvedAt!: string | null;
  @ApiProperty({ description: 'True when the policy exists but an owner has not approved it yet: nothing runs' }) awaitingApproval!: boolean;
}

@Injectable()
export class RetentionService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
  ) {}

  private orgId(user: AuthUser): string {
    if (!user.organizationId) throw new NotFoundError('Organization', 'none');
    return user.organizationId;
  }

  async get(user: AuthUser) {
    const organizationId = this.orgId(user);
    const policy = await this.db.selectFrom('dataRetentionPolicies').selectAll().where('organizationId', '=', organizationId).executeTakeFirst();
    const runs = await this.db
      .selectFrom('dataRetentionRuns')
      .select(['id', 'dryRun', 'triggeredBy', 'summary', 'createdAt'])
      .where('organizationId', '=', organizationId)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .execute();
    return {
      policy: {
        guestAnonymizeAfterDays: policy?.guestAnonymizeAfterDays ?? null,
        notificationRedactAfterDays: policy?.notificationRedactAfterDays ?? null,
        inboundPayloadRedactAfterDays: policy?.inboundPayloadRedactAfterDays ?? null,
        enabled: policy?.enabled ?? false,
        approvedAt: policy?.approvedAt ? policy.approvedAt.toISOString() : null,
        awaitingApproval: !!policy && !policy.enabled,
      },
      runs,
    };
  }

  /** Changing the periods always withdraws the approval: an owner must look at the new numbers (ideally after a dry run). */
  async set(user: AuthUser, meta: RequestMeta, dto: RetentionPolicyInputDto) {
    const organizationId = this.orgId(user);
    const existing = await this.db.selectFrom('dataRetentionPolicies').selectAll().where('organizationId', '=', organizationId).executeTakeFirst();
    const guest = dto.guestAnonymizeAfterDays === undefined ? (existing?.guestAnonymizeAfterDays ?? null) : dto.guestAnonymizeAfterDays;
    const notif = dto.notificationRedactAfterDays === undefined ? (existing?.notificationRedactAfterDays ?? null) : dto.notificationRedactAfterDays;
    const inbound = dto.inboundPayloadRedactAfterDays === undefined ? (existing?.inboundPayloadRedactAfterDays ?? null) : dto.inboundPayloadRedactAfterDays;
    await this.db
      .insertInto('dataRetentionPolicies')
      .values({ organizationId, guestAnonymizeAfterDays: guest, notificationRedactAfterDays: notif, inboundPayloadRedactAfterDays: inbound, enabled: false, approvedBy: null, approvedAt: null, updatedBy: user.userId })
      .onConflict((oc) => oc.column('organizationId').doUpdateSet({ guestAnonymizeAfterDays: guest, notificationRedactAfterDays: notif, inboundPayloadRedactAfterDays: inbound, enabled: false, approvedBy: null, approvedAt: null, updatedBy: user.userId }))
      .execute();
    await this.audit.log({ user, meta }, { action: 'retention.policy_set', entityType: 'DataRetentionPolicy', entityId: organizationId, after: { guestAnonymizeAfterDays: guest, notificationRedactAfterDays: notif, inboundPayloadRedactAfterDays: inbound, enabled: false } });
    return this.get(user);
  }

  async approve(user: AuthUser, meta: RequestMeta) {
    const organizationId = this.orgId(user);
    const policy = await this.db.selectFrom('dataRetentionPolicies').selectAll().where('organizationId', '=', organizationId).executeTakeFirst();
    if (!policy || (policy.guestAnonymizeAfterDays === null && policy.notificationRedactAfterDays === null && policy.inboundPayloadRedactAfterDays === null)) {
      throw new DomainValidationError('Set at least one retention period before approving the policy');
    }
    await this.db.updateTable('dataRetentionPolicies').set({ enabled: true, approvedBy: user.userId, approvedAt: new Date(), updatedBy: user.userId }).where('organizationId', '=', organizationId).execute();
    await this.audit.log({ user, meta }, { action: 'retention.policy_approved', entityType: 'DataRetentionPolicy', entityId: organizationId, after: { guestAnonymizeAfterDays: policy.guestAnonymizeAfterDays, notificationRedactAfterDays: policy.notificationRedactAfterDays } });
    return this.get(user);
  }

  async disable(user: AuthUser, meta: RequestMeta) {
    const organizationId = this.orgId(user);
    await this.db.updateTable('dataRetentionPolicies').set({ enabled: false, approvedBy: null, approvedAt: null, updatedBy: user.userId }).where('organizationId', '=', organizationId).execute();
    await this.audit.log({ user, meta }, { action: 'retention.policy_disabled', entityType: 'DataRetentionPolicy', entityId: organizationId });
    return this.get(user);
  }

  dryRun(user: AuthUser) {
    return runRetention(this.db, this.orgId(user), { dryRun: true, triggeredBy: `user:${user.userId}` });
  }

  async run(user: AuthUser, meta: RequestMeta) {
    const result = await runRetention(this.db, this.orgId(user), { dryRun: false, triggeredBy: `user:${user.userId}` });
    if (!result.applied) throw new BadRequestException(result.reason);
    await this.audit.log({ user, meta }, { action: 'retention.run', entityType: 'DataRetentionPolicy', entityId: result.organizationId, after: { ...result.summary } });
    return result;
  }
}

@ApiTags('Data retention')
@Controller('organizations/me/retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get()
  @Roles(UserRole.PROPERTY_OWNER)
  @ApiOperation({ summary: "The organization's personal-data retention policy and the last runs (owners only)" })
  @ApiEnvelope(PolicyView)
  @ApiStandardErrors()
  get(@CurrentUser() user: AuthUser) {
    return this.retention.get(user);
  }

  @Put()
  @Roles(UserRole.PROPERTY_OWNER)
  @RequireActiveOrg()
  @ApiOperation({ summary: 'Set the retention periods. This withdraws any earlier approval; nothing runs until an owner approves again.' })
  @ApiEnvelope(PolicyView)
  @ApiStandardErrors()
  set(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: RetentionPolicyInputDto) {
    return this.retention.set(user, meta, dto);
  }

  @Post('dry-run')
  @HttpCode(200)
  @Roles(UserRole.PROPERTY_OWNER)
  @ApiOperation({ summary: 'Count what a run would anonymise or blank, without changing anything' })
  @ApiStandardErrors()
  dryRun(@CurrentUser() user: AuthUser) {
    return this.retention.dryRun(user);
  }

  @Post('approve')
  @HttpCode(200)
  @Roles(UserRole.PROPERTY_OWNER)
  @RequireActiveOrg()
  @ApiOperation({ summary: 'Approve and enable the policy so scheduled runs may apply it' })
  @ApiEnvelope(PolicyView)
  @ApiStandardErrors()
  approve(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.retention.approve(user, meta);
  }

  @Post('disable')
  @HttpCode(200)
  @Roles(UserRole.PROPERTY_OWNER)
  @ApiOperation({ summary: 'Switch the policy off (the periods are kept)' })
  @ApiEnvelope(PolicyView)
  @ApiStandardErrors()
  disable(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.retention.disable(user, meta);
  }

  @Post('run')
  @HttpCode(200)
  @Roles(UserRole.PROPERTY_OWNER)
  @RequireActiveOrg()
  @ApiOperation({ summary: 'Apply an approved policy now (one batch of at most 500 guests). Irreversible.' })
  @ApiStandardErrors()
  run(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() _dto: RetentionRunDto) {
    return this.retention.run(user, meta);
  }
}

@Module({ controllers: [RetentionController], providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
