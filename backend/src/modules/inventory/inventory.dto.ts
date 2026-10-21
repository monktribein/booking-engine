import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsUUID, IsOptional, IsString, Length, Max, Min, ValidateIf } from 'class-validator';
import { IsDateOnly } from '../../common/dto';
import { InventoryBlockReason, InventoryBlockStatus } from '../../database/enums';

export class AvailabilityQueryDto {
  @ApiProperty({ example: '2026-10-05' }) @IsDateOnly() checkIn!: string;
  @ApiProperty({ example: '2026-10-08' }) @IsDateOnly() checkOut!: string;
  @ApiProperty({ example: 2 }) @Type(() => Number) @IsInt() @Min(1) @Max(50) adults!: number;
  @ApiPropertyOptional({ example: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(50) children?: number;
  @ApiPropertyOptional({ example: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) rooms?: number;
}

export class CreateBlockDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiPropertyOptional({ description: 'Block one specific physical room (quantity is then 1)' }) @IsOptional() @IsUUID() roomId?: string;
  @ApiProperty({ example: '2026-10-05' }) @IsDateOnly() startDate!: string;
  @ApiProperty({ example: '2026-10-08', description: 'Exclusive' }) @IsDateOnly() endDate!: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) @Max(5000) quantity?: number;
  @ApiProperty({ enum: InventoryBlockReason }) @IsEnum(InventoryBlockReason) reason!: InventoryBlockReason;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) notes?: string;
}

export class InventoryBlockDto {
  @ApiProperty() _id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() roomTypeId!: string;
  @ApiPropertyOptional({ nullable: true }) roomId!: string | null;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ enum: InventoryBlockReason }) reason!: InventoryBlockReason;
  @ApiProperty({ enum: InventoryBlockStatus }) status!: InventoryBlockStatus;
}

export class SetRestrictionsDto {
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiProperty({ example: '2026-10-01' }) @IsDateOnly() from!: string;
  @ApiProperty({ example: '2026-10-31', description: 'Exclusive' }) @IsDateOnly() to!: string;
  @ApiPropertyOptional({ nullable: true, description: 'null clears it' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(365)
  minimumStay?: number | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(365)
  maximumStay?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() closedToArrival?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() closedToDeparture?: boolean;
  @ApiPropertyOptional({ description: 'Stop sell on all channels' }) @IsOptional() @IsBoolean() stopSell?: boolean;
  @ApiPropertyOptional({ description: 'Hard close' }) @IsOptional() @IsBoolean() closed?: boolean;
}

class CalendarCellDto {
  @ApiProperty() date!: string;
  @ApiProperty() initialized!: boolean;
  @ApiProperty() total!: number;
  @ApiProperty() sold!: number;
  @ApiProperty() blocked!: number;
  @ApiProperty() available!: number;
  @ApiProperty() overbooked!: number;
  @ApiProperty() stopSell!: boolean;
  @ApiPropertyOptional({ type: Object, nullable: true }) restriction!: Record<string, unknown> | null;
}

class CalendarRoomTypeDto {
  @ApiProperty() roomTypeId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [CalendarCellDto] }) days!: CalendarCellDto[];
}

export class CalendarDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: [CalendarRoomTypeDto] }) roomTypes!: CalendarRoomTypeDto[];
  @ApiProperty({ type: [Object] }) reservations!: Record<string, unknown>[];
  @ApiProperty({ type: [InventoryBlockDto] }) blocks!: InventoryBlockDto[];
}

class RatePlanQuoteDto {
  @ApiProperty() ratePlanId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() mealPlan!: string;
  @ApiProperty({ type: Object }) cancellationPolicy!: Record<string, unknown>;
  @ApiProperty({ description: 'Average nightly price per room including extra-guest charges' }) nightly!: number;
  @ApiProperty({ type: [Object], description: 'Per-night price of the first room: { date, amount, rate, extra, ruleId? }. amount = rate + extra and is what is frozen on the booking.' }) nightlyRates!: Record<string, unknown>[];
  @ApiProperty({ description: 'Extra-guest charges included in subtotal' }) extraGuestCharges!: number;
  @ApiPropertyOptional({ description: 'Set instead of a discount when the promo code does not apply to this plan (for example below its minimum booking value)' }) promoProblem?: string;
  @ApiProperty() subtotal!: number;
  @ApiProperty() tax!: number;
  @ApiPropertyOptional() discount?: number;
  @ApiProperty() total!: number;
}

export class AvailabilityResultDto {
  @ApiProperty() roomTypeId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() maxOccupancy!: number;
  @ApiProperty({ description: 'Rooms free on every night of the stay' }) availableUnits!: number;
  @ApiProperty() bookable!: boolean;
  @ApiProperty({ type: [String], description: 'Why it is not bookable (min stay, stop sell, CTA...)' }) reasons!: string[];
  @ApiProperty({ type: [RatePlanQuoteDto] }) ratePlans!: RatePlanQuoteDto[];
}
