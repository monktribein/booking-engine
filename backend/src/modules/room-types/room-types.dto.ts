import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf, ValidateNested } from 'class-validator';
import { RoomTypeStatus } from '../../database/enums';
import { ImageDto } from '../properties/dto/property.dto';

export class CreateRoomTypeDto {
  @ApiProperty({ example: 'Deluxe AC Room' }) @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional({ example: 'deluxe-ac' }) @IsOptional() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @Length(1, 80) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @ApiProperty({ example: 3 }) @IsInt() @Min(1) @Max(50) maxOccupancy!: number;
  @ApiProperty({ example: 350000, description: 'Rack rate per night, minor units' }) @IsInt() @Min(0) basePrice!: number;
  @ApiPropertyOptional({ example: 2, nullable: true, description: 'Guests the nightly price covers per room. Omit or null: the price covers maxOccupancy (no extra-guest charges).' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(50)
  baseOccupancy?: number | null;
  @ApiPropertyOptional({ example: 80000, description: 'Per extra adult per night above baseOccupancy, minor units' }) @IsOptional() @IsInt() @Min(0) extraAdultCharge?: number;
  @ApiPropertyOptional({ example: 40000, description: 'Per extra child per night above baseOccupancy, minor units' }) @IsOptional() @IsInt() @Min(0) extraChildCharge?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) amenities?: string[];
  @ApiPropertyOptional({ type: [ImageDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  images?: ImageDto[];
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional({ default: true, description: 'Also create a flexible STD rate plan at basePrice' })
  @IsOptional()
  @IsBoolean()
  createDefaultRatePlan?: boolean;
}

export class UpdateRoomTypeDto extends PartialType(OmitType(CreateRoomTypeDto, ['createDefaultRatePlan'] as const)) {
  @ApiPropertyOptional({ enum: [RoomTypeStatus.ACTIVE, RoomTypeStatus.INACTIVE] })
  @IsOptional()
  @IsEnum([RoomTypeStatus.ACTIVE, RoomTypeStatus.INACTIVE])
  status?: RoomTypeStatus;
}

export class RoomTypeDto {
  @ApiProperty() _id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty() maxOccupancy!: number;
  @ApiProperty() basePrice!: number;
  @ApiPropertyOptional({ nullable: true }) baseOccupancy?: number | null;
  @ApiProperty() extraAdultCharge!: number;
  @ApiProperty() extraChildCharge!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'Physical rooms of this type (maintained automatically)' }) totalRooms!: number;
  @ApiProperty({ type: [String] }) amenities!: string[];
  @ApiProperty({ type: [ImageDto] }) images!: ImageDto[];
  @ApiProperty({ enum: RoomTypeStatus }) status!: RoomTypeStatus;
  @ApiProperty() createdAt!: string;
}
