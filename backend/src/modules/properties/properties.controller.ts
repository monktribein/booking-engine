import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, Roles } from '../../common/decorators';
import { UserRole } from '../../database/enums';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseObjectIdPipe } from '../../common/utils';
import { CreatePropertyDto, PropertyDto, UpdatePropertyDto } from './dto/property.dto';
import { PropertiesService } from './properties.service';

@ApiTags('Properties')
@Controller('properties')
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Get()
  @ApiOperation({ summary: 'Properties the current user can access' })
  @ApiEnvelope(PropertyDto, { paginated: true })
  @ApiStandardErrors()
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.properties.list(user, q.page, q.limit);
  }

  @Post()
  @Roles(UserRole.PROPERTY_OWNER, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a property (PROPERTY_OWNER or SUPER_ADMIN); the creator becomes its owner' })
  @ApiEnvelope(PropertyDto, { status: 201 })
  @ApiStandardErrors({ conflict: 'SLUG_TAKEN' })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: CreatePropertyDto) {
    return this.properties.create(user, meta, dto);
  }

  @Get(':id')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'id', entity: 'property' })
  @ApiOperation({ summary: 'Get a property' })
  @ApiEnvelope(PropertyDto)
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.properties.get(id);
  }

  @Patch(':id')
  @PropertyAccess(Permission.PROPERTY_EDIT, { in: 'param', key: 'id', entity: 'property' })
  @ApiOperation({ summary: 'Update a property (currency and time zone are immutable)' })
  @ApiEnvelope(PropertyDto)
  @ApiStandardErrors({ notFound: true, conflict: 'SLUG_TAKEN' })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdatePropertyDto) {
    return this.properties.update(user, meta, id, dto);
  }

  @Delete(':id')
  @PropertyAccess(Permission.PROPERTY_DELETE, { in: 'param', key: 'id', entity: 'property' })
  @ApiOperation({ summary: 'Archive (soft-delete) a property. Refused while it has upcoming reservations.' })
  @ApiEnvelope(PropertyDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  archive(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.properties.archive(user, meta, id);
  }
}
