import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsUUID,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from '../../common/dto';
import { CancellationPenaltyType, MealPlan, PromotionType, RateAdjustment, RatePlanStatus, RatePlanType, RateRuleStatus } from '../../database/enums';

export class CancellationPolicyDto {
  @ApiProperty() @IsBoolean() refundable!: boolean;
  @ApiPropertyOptional({ example: 48 }) @IsOptional() @IsInt() @Min(0) @Max(8760) freeCancellationHours?: number;
  @ApiPropertyOptional({ enum: CancellationPenaltyType }) @IsOptional() @IsEnum(CancellationPenaltyType) penaltyType?: CancellationPenaltyType;
  @ApiPropertyOptional({ description: 'Percent for PERCENTAGE' }) @IsOptional() @IsNumber() @Min(0) @Max(100) penaltyValue?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) description?: string;
}

export class CreateRatePlanDto {
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiProperty({ example: 'Bed & Breakfast' }) @IsString() @Length(1, 120) name!: string;
  @ApiProperty({ example: 'BB' }) @Matches(/^[A-Za-z0-9_-]{1,40}$/) code!: string;
  @ApiProperty({ enum: RatePlanType }) @IsEnum(RatePlanType) type!: RatePlanType;
  @ApiProperty({ example: 390000, description: 'Per room per night, minor units' }) @IsInt() @Min(0) basePrice!: number;
  @ApiPropertyOptional({ enum: MealPlan }) @IsOptional() @IsEnum(MealPlan) mealPlan?: MealPlan;
  @ApiProperty({ type: CancellationPolicyDto }) @ValidateNested() @Type(() => CancellationPolicyDto) cancellationPolicy!: CancellationPolicyDto;
}

export class UpdateRatePlanDto extends PartialType(OmitType(CreateRatePlanDto, ['roomTypeId', 'code'] as const)) {
  @ApiPropertyOptional({ enum: [RatePlanStatus.ACTIVE, RatePlanStatus.INACTIVE] })
  @IsOptional()
  @IsEnum([RatePlanStatus.ACTIVE, RatePlanStatus.INACTIVE])
  status?: RatePlanStatus;
}

export class RatePlanDto {
  @ApiProperty() _id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() roomTypeId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: RatePlanType }) type!: RatePlanType;
  @ApiProperty() basePrice!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: MealPlan }) mealPlan!: MealPlan;
  @ApiProperty({ type: CancellationPolicyDto }) cancellationPolicy!: CancellationPolicyDto;
  @ApiProperty({ enum: RatePlanStatus }) status!: RatePlanStatus;
}

export class CreatePromotionDto {
  @ApiProperty({ example: 'DIWALI10' }) @Matches(/^[A-Za-z0-9_-]{3,30}$/) code!: string;
  @ApiProperty() @IsString() @Length(1, 120) name!: string;
  @ApiProperty({ enum: PromotionType }) @IsEnum(PromotionType) type!: PromotionType;
  @ApiProperty({ description: 'Percent (0-100) or minor units' }) @IsNumber() @Min(0) value!: number;
  @ApiProperty({ example: '2026-10-01' }) @IsDateOnly() validFrom!: string;
  @ApiProperty({ example: '2026-11-15', description: 'Exclusive' }) @IsDateOnly() validTo!: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) minNights?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID(undefined, { each: true }) roomTypeIds?: string[];
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ example: 100, description: 'Total number of bookings that may use the code. Omit for unlimited. Cancelled bookings and expired holds give their use back.' }) @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @ApiPropertyOptional({ example: 1, description: 'How many times one guest (identified by e-mail address) may use the code. Omit for unlimited.' }) @IsOptional() @IsInt() @Min(1) maxPerGuest?: number;
  @ApiPropertyOptional({ example: 500000, description: 'Minimum booking total (minor units, after tax, before the discount) the code applies to. 0 = no minimum.' }) @IsOptional() @IsInt() @Min(0) minBookingValue?: number;
}

export class UpdatePromotionDto extends PartialType(OmitType(CreatePromotionDto, ['code'] as const)) {}

export class PromotionDto {
  @ApiProperty() _id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PromotionType }) type!: PromotionType;
  @ApiProperty() value!: number;
  @ApiProperty() validFrom!: string;
  @ApiProperty() validTo!: string;
  @ApiProperty() minNights!: number;
  @ApiProperty({ type: [String] }) roomTypeIds!: string[];
  @ApiProperty() active!: boolean;
  @ApiPropertyOptional({ nullable: true }) maxRedemptions?: number | null;
  @ApiPropertyOptional({ nullable: true }) maxPerGuest?: number | null;
  @ApiProperty() minBookingValue!: number;
  @ApiPropertyOptional({ description: 'Active redemptions so far (list endpoint only)' }) redeemed?: number;
}

const DAYS = [0, 1, 2, 3, 4, 5, 6];

export class CreateRateRuleDto {
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiPropertyOptional({ description: 'Only this rate plan. Omit for every rate plan of the room type.' }) @IsOptional() @IsUUID() ratePlanId?: string;
  @ApiProperty({ example: 'Diwali week' }) @IsString() @Length(1, 120) name!: string;
  @ApiProperty({ example: '2026-11-05' }) @IsDateOnly() startDate!: string;
  @ApiProperty({ example: '2026-11-12', description: 'Exclusive' }) @IsDateOnly() endDate!: string;
  @ApiPropertyOptional({ type: [Number], example: [5, 6], description: '0 = Sunday .. 6 = Saturday. Omit for every day.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @IsIn(DAYS, { each: true })
  daysOfWeek?: number[];
  @ApiProperty({ enum: RateAdjustment }) @IsEnum(RateAdjustment) adjustment!: RateAdjustment;
  @ApiPropertyOptional({ example: 520000, description: 'FIXED: the nightly price, minor units' }) @IsOptional() @IsInt() @Min(0) amount?: number;
  @ApiPropertyOptional({ example: 25, description: 'PERCENT: added to the base price, -90 .. 500' }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-90) @Max(500) percent?: number;
  @ApiPropertyOptional({ default: 0, description: 'Higher wins when rules overlap' }) @IsOptional() @IsInt() @Min(0) @Max(1000) priority?: number;
}

export class UpdateRateRuleDto extends PartialType(OmitType(CreateRateRuleDto, ['roomTypeId'] as const)) {
  @ApiPropertyOptional({ enum: RateRuleStatus }) @IsOptional() @IsEnum(RateRuleStatus) status?: RateRuleStatus;
}

export class RateRuleDto {
  @ApiProperty() _id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() roomTypeId!: string;
  @ApiPropertyOptional({ nullable: true }) ratePlanId?: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiPropertyOptional({ type: [Number], nullable: true }) daysOfWeek?: number[] | null;
  @ApiProperty({ enum: RateAdjustment }) adjustment!: RateAdjustment;
  @ApiPropertyOptional({ nullable: true }) amount?: number | null;
  @ApiPropertyOptional({ nullable: true }) percent?: number | null;
  @ApiProperty() priority!: number;
  @ApiProperty({ enum: RateRuleStatus }) status!: RateRuleStatus;
}

export class RateCalendarQueryDto {
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiPropertyOptional({ description: 'Defaults to the cheapest active rate plan of the room type' }) @IsOptional() @IsUUID() ratePlanId?: string;
  @ApiProperty({ example: '2026-11-01' }) @IsDateOnly() from!: string;
  @ApiProperty({ example: '2026-12-01', description: 'Exclusive, at most 366 days after from' }) @IsDateOnly() to!: string;
}

export class RateCalendarDayDto {
  @ApiProperty() date!: string;
  @ApiProperty({ description: 'The rate plan base price' }) base!: number;
  @ApiProperty({ description: 'The nightly price after the winning rule, before extra-guest charges' }) rate!: number;
  @ApiPropertyOptional({ nullable: true }) ruleId?: string | null;
  @ApiPropertyOptional({ nullable: true }) ruleName?: string | null;
}
