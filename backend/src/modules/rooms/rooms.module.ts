import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { ChangeRoomStatusDto, CreateRoomDto, RetireRoomDto, RoomDto, UpdateRoomDto } from './rooms.dto';
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
  @ApiOperation({ summary: 'Physical rooms of a room type (retired rooms only with ?includeRetired=true)' })
  @ApiEnvelope(RoomDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  list(@Param('roomTypeId', ParseUuidPipe) roomTypeId: string, @Query('includeRetired') includeRetired?: string) {
    return this.rooms.list(roomTypeId, includeRetired === 'true');
  }

  @Post('room-types/:roomTypeId/rooms')
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'roomTypeId', entity: 'roomType' })
  @ApiOperation({ summary: 'Add a physical room (e.g. 104). Future inventory of the type grows by one.' })
  @ApiEnvelope(RoomDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE' })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('roomTypeId', ParseUuidPipe) roomTypeId: string, @Body() dto: CreateRoomDto) {
    return this.rooms.create(user, meta, roomTypeId, dto);
  }

  @Get('rooms/:id')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({ summary: 'Get a room' })
  @ApiEnvelope(RoomDto)
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseUuidPipe) id: string) {
    return this.rooms.get(id);
  }

  @Patch('rooms/:id')
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({ summary: 'Edit a room or move it to another room type (capacity moves with it)' })
  @ApiEnvelope(RoomDto)
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE / ROOM_ASSIGNMENT_CONFLICT / INVALID_STATE_TRANSITION' })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: UpdateRoomDto) {
    return this.rooms.update(user, meta, id, dto);
  }

  @Get('rooms/:id/retirement-check')
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({ summary: 'Whether the room can be retired, and the upcoming reservations / blocks that stand in the way' })
  @ApiStandardErrors({ notFound: true })
  retirementCheck(@Param('id', ParseUuidPipe) id: string) {
    return this.rooms.retirementCheck(id);
  }

  @Post('rooms/:id/retire')
  @HttpCode(200)
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({
    summary: 'Retire a physical room (history is kept; capacity leaves the inventory)',
    description: 'Refused with ROOM_HAS_FUTURE_BOOKINGS (listing the reservations) while the room is assigned to an upcoming stay, and with INVALID_STATE_TRANSITION while a guest is in it. Retiring a retired room changes nothing.',
  })
  @ApiEnvelope(RoomDto)
  @ApiStandardErrors({ notFound: true, conflict: 'ROOM_HAS_FUTURE_BOOKINGS / INVALID_STATE_TRANSITION' })
  retire(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: RetireRoomDto) {
    return this.rooms.retire(user, meta, id, dto);
  }

  @Post('rooms/:id/reinstate')
  @HttpCode(200)
  @PropertyAccess(Permission.ROOMS_MANAGE, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({ summary: 'Bring a retired room back into the inventory' })
  @ApiEnvelope(RoomDto)
  @ApiStandardErrors({ notFound: true, conflict: 'DUPLICATE' })
  reinstate(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.rooms.reinstate(user, meta, id);
  }

  @Post('rooms/:id/status')
  @HttpCode(200)
  @PropertyAccess(Permission.ROOM_STATUS, { in: 'param', key: 'id', entity: 'room' })
  @ApiOperation({ summary: 'Set AVAILABLE / CLEANING / MAINTENANCE / BLOCKED (optionally blocking inventory until a date)' })
  @ApiEnvelope(RoomStatusResultDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION / ROOM_NOT_AVAILABLE' })
  changeStatus(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: ChangeRoomStatusDto) {
    return this.rooms.changeStatus(user, meta, id, dto);
  }
}

@Module({ controllers: [RoomsController], providers: [RoomsService], exports: [RoomsService] })
export class RoomsModule {}
