import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, Roles } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { OrganizationStatus, UserRole } from '../../database/enums';
import { NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';

export class OrganizationDto {
  @ApiProperty() _id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: OrganizationStatus }) status!: OrganizationStatus;
  @ApiProperty() createdAt!: string;
}

export class UpdateOrganizationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 160) name?: string;
}

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
  ) {}

  async mine(user: AuthUser) {
    if (!user.organizationId) throw new NotFoundError('Organization', 'none');
    const org = await this.db.selectFrom('organizations').selectAll().where('id', '=', user.organizationId).executeTakeFirst();
    if (!org) throw new NotFoundError('Organization', user.organizationId);
    return org;
  }

  async update(user: AuthUser, meta: RequestMeta, dto: UpdateOrganizationDto) {
    const before = await this.mine(user);
    const org = dto.name === undefined ? before : await this.db.updateTable('organizations').set({ name: dto.name.trim() }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow();
    await this.audit.log({ user, meta }, { action: 'organization.update', entityType: 'Organization', entityId: before.id, before: { name: before.name }, after: dto as Record<string, unknown> });
    return org;
  }
}

@ApiTags('Organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get('me')
  @ApiOperation({ summary: "The signed-in user's organization" })
  @ApiEnvelope(OrganizationDto)
  @ApiStandardErrors({ notFound: true })
  mine(@CurrentUser() user: AuthUser) {
    return this.orgs.mine(user);
  }

  @Patch('me')
  @Roles(UserRole.PROPERTY_OWNER)
  @ApiOperation({ summary: 'Rename the organization (owners only)' })
  @ApiEnvelope(OrganizationDto)
  @ApiStandardErrors({ notFound: true })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: UpdateOrganizationDto) {
    return this.orgs.update(user, meta, dto);
  }
}

@Module({ controllers: [OrganizationsController], providers: [OrganizationsService], exports: [OrganizationsService] })
export class OrganizationsModule {}
