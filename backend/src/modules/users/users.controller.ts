import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { AddStaffDto, PropertyStaffDto, UpdateMeDto, UserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users/me')
  @ApiOperation({ summary: 'Current user profile' })
  @ApiEnvelope(UserDto)
  @ApiStandardErrors()
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.userId);
  }

  @Patch('users/me')
  @ApiOperation({ summary: 'Update own name/phone' })
  @ApiEnvelope(UserDto)
  @ApiStandardErrors()
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(user, dto);
  }

  @Get('properties/:propertyId/users')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'List staff with access to a property' })
  @ApiEnvelope(PropertyStaffDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  list(@Param('propertyId', ParseUuidPipe) propertyId: string) {
    return this.users.listStaff(propertyId);
  }

  @Post('properties/:propertyId/users')
  @PropertyAccess(Permission.STAFF_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Give a user access to a property (invites new users by email)' })
  @ApiEnvelope(PropertyStaffDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE / EMAIL_TAKEN' })
  add(
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
    @Param('propertyId', ParseUuidPipe) propertyId: string,
    @Body() dto: AddStaffDto,
  ) {
    return this.users.addStaff(user, meta, propertyId, dto);
  }

  @Delete('properties/:propertyId/users/:userId')
  @PropertyAccess(Permission.STAFF_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: "Revoke a user's access to a property" })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  remove(
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
    @Param('propertyId', ParseUuidPipe) propertyId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    return this.users.removeStaff(user, meta, propertyId, userId);
  }
}
