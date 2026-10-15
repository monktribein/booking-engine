import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, PropertyAccessContext } from '../../common/auth/auth-user';
import { CurrentUser, PropertyCtx } from '../../common/decorators';
import { DateRangeQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseUuidPipe, toUuid } from '../../common/utils';
import { AvailabilityService, CalendarService } from '../../database/services/availability.service';
import { InventoryService } from '../../database/services/inventory.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AvailabilityQueryDto, AvailabilityResultDto, CalendarDto, CreateBlockDto, InventoryBlockDto, SetRestrictionsDto } from './inventory.dto';

/**
 * Thin HTTP layer over the data-layer inventory services, which own the
 * atomic counters. Every write here commits its outbox rows, and the flush
 * that follows hands them to the sync queues.
 */
@ApiTags('Inventory')
@Controller()
export class InventoryController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly availability: AvailabilityService,
    private readonly inventory: InventoryService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  @Get('properties/:propertyId/inventory')
  @PropertyAccess(Permission.INVENTORY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Inventory calendar: per room type and night, total/sold/blocked/available, restrictions, plus overlapping reservations and blocks' })
  @ApiEnvelope(CalendarDto)
  @ApiStandardErrors({ notFound: true })
  getInventory(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query() q: DateRangeQueryDto) {
    return this.calendar.getCalendar(propertyId, q.from, q.to);
  }

  @Get('properties/:propertyId/availability')
  @PropertyAccess(Permission.INVENTORY_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Sellable room types for a stay, with restriction checks and priced rate plans' })
  @ApiEnvelope(AvailabilityResultDto, { isArray: true })
  @ApiStandardErrors({ notFound: true })
  getAvailability(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query() q: AvailabilityQueryDto) {
    return this.availability.search({ propertyId, ...q });
  }

  @Post('inventory/block')
  @PropertyAccess(Permission.INVENTORY_MANAGE, { in: 'body', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Block inventory (maintenance, owner use, event...). All-or-nothing across the date range.' })
  @ApiEnvelope(InventoryBlockDto, { status: 201 })
  @ApiStandardErrors({ notFound: true, conflict: 'ROOM_NOT_AVAILABLE / ROOM_ASSIGNMENT_CONFLICT' })
  async block(@CurrentUser() user: AuthUser, @PropertyCtx() ctx: PropertyAccessContext, @Body() dto: CreateBlockDto) {
    const block = await this.inventory.createBlock({
      propertyId: ctx.propertyId,
      roomTypeId: toUuid(dto.roomTypeId, 'roomTypeId'),
      roomId: dto.roomId ? toUuid(dto.roomId, 'roomId') : null,
      startDate: dto.startDate,
      endDate: dto.endDate,
      quantity: dto.quantity,
      reason: dto.reason,
      notes: dto.notes,
      createdBy: user.userId,
    });
    void this.outbox.flush();
    return block;
  }

  @Delete('inventory/block/:id')
  @PropertyAccess(Permission.INVENTORY_MANAGE, { in: 'param', key: 'id', entity: 'inventoryBlock' })
  @ApiOperation({ summary: 'Release a block; the rooms become sellable again on every channel' })
  @ApiEnvelope(InventoryBlockDto)
  @ApiStandardErrors({ notFound: true })
  async unblock(@CurrentUser() user: AuthUser, @PropertyCtx() ctx: PropertyAccessContext, @Param('id', ParseUuidPipe) id: string) {
    const block = await this.inventory.releaseBlock(ctx.propertyId, id, user.userId);
    void this.outbox.flush();
    return block;
  }

  @Put('properties/:propertyId/restrictions')
  @HttpCode(200)
  @PropertyAccess(Permission.INVENTORY_MANAGE, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Set stop sell / closed / min stay / max stay / CTA / CTD for a date range' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  async setRestrictions(
    @CurrentUser() user: AuthUser,
    @Param('propertyId', ParseUuidPipe) propertyId: string,
    @Body() dto: SetRestrictionsDto,
  ) {
    const { roomTypeId, from, to, ...patch } = dto;
    await this.inventory.setRestrictions({ propertyId, roomTypeId: toUuid(roomTypeId, 'roomTypeId'), from, to, patch, userId: user.userId });
    void this.outbox.flush();
    return { ok: true };
  }
}

@Module({ controllers: [InventoryController] })
export class InventoryModule {}
