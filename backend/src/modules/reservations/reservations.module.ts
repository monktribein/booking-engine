import { Body, Controller, Get, Headers, HttpCode, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, PropertyAccessContext } from '../../common/auth/auth-user';
import { CurrentUser, PropertyCtx } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { DomainValidationError } from '../../database/errors';
import {
  CancelReservationDto,
  CancelResultDto,
  CheckInDto,
  CheckOutResultDto,
  CreateReservationDto,
  ReservationDto,
  ReservationListQueryDto,
  RoomAssignmentDto,
  UpdateReservationDto,
} from './reservations.dto';
import { CsvImportController, CsvImportService } from './csv-import';
import { ReservationsService } from './reservations.service';

const byId = (permission: Permission) => PropertyAccess(permission, { in: 'param', key: 'id', entity: 'reservation' });

@ApiTags('Reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  @PropertyAccess(Permission.RESERVATIONS_MANAGE, { in: 'body', key: 'propertyId', entity: 'property' })
  @ApiOperation({
    summary: 'Create a reservation (staff)',
    description:
      'Validates dates and room types, then in ONE database transaction atomically decrements inventory for every night (all-or-nothing), creates the reservation and queues channel sync. With 1 room left and two simultaneous requests, one succeeds and the other gets 409 ROOM_NOT_AVAILABLE.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retries with the same key return the original reservation' })
  @ApiEnvelope(ReservationDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'ROOM_NOT_AVAILABLE / RESTRICTION_VIOLATION / INVENTORY_NOT_INITIALIZED' })
  async create(
    @CurrentUser() user: AuthUser,
    @PropertyCtx() ctx: PropertyAccessContext,
    @Body() dto: CreateReservationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey && !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
      throw new DomainValidationError('Idempotency-Key must be 8-100 characters of [A-Za-z0-9_-]');
    }
    const { reservation } = await this.reservations.create(user, ctx, dto, idempotencyKey);
    return reservation;
  }

  @Get()
  @PropertyAccess(Permission.RESERVATIONS_VIEW, { in: 'query', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'List/search reservations of a property' })
  @ApiEnvelope(ReservationDto, { paginated: true })
  @ApiStandardErrors()
  list(@PropertyCtx() ctx: PropertyAccessContext, @Query() q: ReservationListQueryDto) {
    return this.reservations.list(ctx.propertyId, q);
  }

  @Get(':id')
  @byId(Permission.RESERVATIONS_VIEW)
  @ApiOperation({ summary: 'Get a reservation' })
  @ApiEnvelope(ReservationDto)
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseUuidPipe) id: string) {
    return this.reservations.get(id);
  }

  @Patch(':id')
  @byId(Permission.RESERVATIONS_MANAGE)
  @ApiOperation({ summary: 'Update guest details/occupancy, or change dates (re-reserves inventory atomically and re-prices new nights)' })
  @ApiEnvelope(ReservationDto)
  @ApiStandardErrors({ notFound: true, conflict: 'ROOM_NOT_AVAILABLE / INVALID_STATE_TRANSITION' })
  update(@CurrentUser() user: AuthUser, @PropertyCtx() ctx: PropertyAccessContext, @Param('id', ParseUuidPipe) id: string, @Body() dto: UpdateReservationDto) {
    return this.reservations.update(user, ctx, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @byId(Permission.RESERVATIONS_MANAGE)
  @ApiOperation({ summary: 'Cancel: releases every night, queues refunds per the frozen cancellation policy, and syncs channels. Idempotent.' })
  @ApiEnvelope(CancelResultDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  cancel(@CurrentUser() user: AuthUser, @PropertyCtx() ctx: PropertyAccessContext, @Param('id', ParseUuidPipe) id: string, @Body() dto: CancelReservationDto) {
    return this.reservations.cancel(user, ctx, id, dto);
  }

  @Post(':id/check-in')
  @HttpCode(200)
  @byId(Permission.FRONT_DESK)
  @ApiOperation({ summary: 'Check in (every line needs an AVAILABLE room; rooms become OCCUPIED)' })
  @ApiEnvelope(ReservationDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION / ROOM_NOT_READY / ROOM_ASSIGNMENT_CONFLICT' })
  checkIn(@CurrentUser() user: AuthUser, @PropertyCtx() ctx: PropertyAccessContext, @Param('id', ParseUuidPipe) id: string, @Body() dto: CheckInDto) {
    return this.reservations.checkIn(user, ctx, id, dto);
  }

  @Post(':id/check-out')
  @HttpCode(200)
  @byId(Permission.FRONT_DESK)
  @ApiOperation({ summary: 'Check out (rooms go to CLEANING; unused nights of an early departure are released)' })
  @ApiEnvelope(CheckOutResultDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  checkOut(@CurrentUser() user: AuthUser, @PropertyCtx() ctx: PropertyAccessContext, @Param('id', ParseUuidPipe) id: string) {
    return this.reservations.checkOut(user, ctx, id);
  }

  @Post(':id/no-show')
  @HttpCode(200)
  @byId(Permission.FRONT_DESK)
  @ApiOperation({ summary: 'Mark no-show (from the arrival date); remaining nights are released for resale' })
  @ApiEnvelope(ReservationDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  noShow(@CurrentUser() user: AuthUser, @PropertyCtx() ctx: PropertyAccessContext, @Param('id', ParseUuidPipe) id: string) {
    return this.reservations.noShow(user, ctx, id);
  }

  @Post(':id/assign-room')
  @HttpCode(200)
  @byId(Permission.FRONT_DESK)
  @ApiOperation({ summary: 'Assign a physical room to one reservation line (conflict-safe)' })
  @ApiEnvelope(ReservationDto)
  @ApiStandardErrors({ notFound: true, conflict: 'ROOM_ASSIGNMENT_CONFLICT' })
  assign(@CurrentUser() user: AuthUser, @PropertyCtx() ctx: PropertyAccessContext, @Param('id', ParseUuidPipe) id: string, @Body() dto: RoomAssignmentDto) {
    return this.reservations.assignRoom(user, ctx, id, dto.reservationRoomId, dto.roomId);
  }
}

@Module({ controllers: [ReservationsController, CsvImportController], providers: [ReservationsService, CsvImportService], exports: [ReservationsService] })
export class ReservationsModule {}
