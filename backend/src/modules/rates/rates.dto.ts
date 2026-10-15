import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
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
import { CancellationPenaltyType, MealPlan, PromotionType, RatePlanStatus, RatePlanType } from '../../database/enums';

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
}
