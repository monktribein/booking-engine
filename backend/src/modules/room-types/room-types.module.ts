import { Body, Controller, Delete, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseObjectIdPipe } from '../../common/utils';
import { CreateRoomTypeDto, RoomTypeDto, UpdateRoomTypeDto } from './room-types.dto';
import { RoomTypesService } from './room-types.service';

@ApiTags('Room types')
@Controller()
export class RoomTypesController {
  constructor(private readonly roomTypes: RoomTypesService) {}

  @Get('properties/:propertyId/room-types')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'List room types of a property' })
  @ApiEnvelope(RoomTypeDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  list(@Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId) {
    return this.roomTypes.list(propertyId);
  }

  @Post('properties/:propertyId/room-types')
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Create a room type (e.g. "Deluxe AC"); add physical rooms separately' })
  @ApiEnvelope(RoomTypeDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE' })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId, @Body() dto: CreateRoomTypeDto) {
    return this.roomTypes.create(user, meta, propertyId, dto);
  }

  @Get('room-types/:id')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'id', entity: 'roomType' })
  @ApiOperation({ summary: 'Get a room type' })
  @ApiEnvelope(RoomTypeDto)
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.roomTypes.get(id);
  }

  @Patch('room-types/:id')
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'id', entity: 'roomType' })
  @ApiOperation({ summary: 'Update a room type' })
  @ApiEnvelope(RoomTypeDto)
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE / INVALID_STATE_TRANSITION' })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateRoomTypeDto) {
    return this.roomTypes.update(user, meta, id, dto);
  }

  @Delete('room-types/:id')
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'id', entity: 'roomType' })
  @ApiOperation({ summary: 'Archive a room type (stop-sells and pushes 0 availability to channels)' })
  @ApiEnvelope(RoomTypeDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  archive(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.roomTypes.archive(user, meta, id);
  }
}

@Module({ controllers: [RoomTypesController], providers: [RoomTypesService], exports: [RoomTypesService] })
export class RoomTypesModule {}
