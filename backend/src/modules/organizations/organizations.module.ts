import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { Connection } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, Roles } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { OrganizationStatus, UserRole } from '../../database/enums';
import { NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
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
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  async mine(user: AuthUser) {
    if (!user.organizationId) throw new NotFoundError('Organization', 'none');
    const org = await this.m.Organization.findById(user.organizationId).lean();
    if (!org) throw new NotFoundError('Organization', user.organizationId);
    return org;
  }

  async update(user: AuthUser, meta: RequestMeta, dto: UpdateOrganizationDto) {
    const before = await this.mine(user);
    const org = await this.m.Organization.findByIdAndUpdate(before._id, { $set: dto }, { new: true, runValidators: true }).lean();
    await this.audit.log({ user, meta }, { action: 'organization.update', entityType: 'Organization', entityId: before._id, before: { name: before.name }, after: dto as Record<string, unknown> });
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
