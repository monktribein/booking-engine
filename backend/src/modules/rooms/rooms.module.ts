import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseObjectIdPipe } from '../../common/utils';
import { ChangeRoomStatusDto, CreateRoomDto, RoomDto, UpdateRoomDto } from './rooms.dto';
import { RoomsService } from './rooms.service';

class RoomStatusResultDto {
  @ApiProperty({ type: RoomDto }) room!: RoomDto;
  @ApiPropertyOptional({ nullable: true }) inventoryBlockId!: string | null;
}

@ApiTags('Rooms')
@Controller()
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get('room-types/:roomTypeId/rooms')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'roomTypeId', entity: 'roomType' })
  @ApiOperation({ summary: 'Physical rooms of a room type' })
  @ApiEnvelope(RoomDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  list(@Param('roomTypeId', ParseObjectIdPipe) roomTypeId: Types.ObjectId) {
    return this.rooms.list(roomTypeId);
  }

  @Post('room-types/:roomTypeId/rooms')
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'roomTypeId', entity: 'roomType' })
  @ApiOperation({ summary: 'Add a physical room (e.g. 104). Future inventory of the type grows by one.' })
  @ApiEnvelope(RoomDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE' })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('roomTypeId', ParseObjectIdPipe) roomTypeId: Types.ObjectId, @Body() dto: CreateRoomDto) {
    return this.rooms.create(user, meta, roomTypeId, dto);
  }

  @Get('rooms/:id')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({ summary: 'Get a room' })
  @ApiEnvelope(RoomDto)
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.rooms.get(id);
  }

  @Patch('rooms/:id')
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({ summary: 'Edit a room or move it to another room type (capacity moves with it)' })
  @ApiEnvelope(RoomDto)
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE / ROOM_ASSIGNMENT_CONFLICT / INVALID_STATE_TRANSITION' })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: UpdateRoomDto) {
    return this.rooms.update(user, meta, id, dto);
  }

  @Post('rooms/:id/status')
  @HttpCode(200)
  @PropertyAccess(Permission.ROOM_STATUS, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({ summary: 'Set AVAILABLE / CLEANING / MAINTENANCE / BLOCKED (optionally blocking inventory until a date)' })
  @ApiEnvelope(RoomStatusResultDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION / ROOM_NOT_AVAILABLE' })
  changeStatus(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Body() dto: ChangeRoomStatusDto) {
    return this.rooms.changeStatus(user, meta, id, dto);
  }
}

@Module({ controllers: [RoomsController], providers: [RoomsService], exports: [RoomsService] })
export class RoomsModule {}
