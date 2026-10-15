import { ApiProperty, ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PropertyStatus } from '../../../database/enums';

export class ImageDto {
  @ApiProperty({ example: 'https://cdn.example.com/p/1.jpg' }) @IsUrl({ protocols: ['https'], require_protocol: true }) url!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 200) caption?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
}

export class CreatePropertyDto {
  @ApiProperty({ example: 'Radha Ashram' }) @IsString() @Length(2, 160) name!: string;
  @ApiPropertyOptional({ example: 'radha-ashram', description: 'Public URL slug; generated from the name if omitted' })
  @IsOptional()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @Length(3, 80)
  slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @ApiProperty() @IsString() @Length(2, 300) address!: string;
  @ApiProperty() @IsString() @Length(1, 100) city!: string;
  @ApiProperty() @IsString() @Length(1, 100) state!: string;
  @ApiProperty({ example: 'IN' }) @Matches(/^[A-Z]{2}$/) country!: string;
  @ApiProperty() @IsString() @Length(2, 20) postalCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiProperty({ example: 'Asia/Kolkata' }) @IsString() @Length(3, 60) timezone!: string;
  @ApiProperty({ example: 'INR' }) @Matches(/^[A-Z]{3}$/) currency!: string;
  @ApiPropertyOptional({ example: '14:00' }) @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) checkInTime?: string;
  @ApiPropertyOptional({ example: '11:00' }) @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) checkOutTime?: string;
  @ApiPropertyOptional({ example: 5 }) @IsOptional() @IsNumber() @Min(0) @Max(100) taxPercent?: number;
  @ApiPropertyOptional({ example: 365 }) @IsOptional() @IsInt() @Min(1) @Max(730) bookingHorizonDays?: number;
  @ApiPropertyOptional({ type: [ImageDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  images?: ImageDto[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) amenities?: string[];
  @ApiPropertyOptional({ enum: [PropertyStatus.DRAFT, PropertyStatus.ACTIVE], default: PropertyStatus.ACTIVE })
  @IsOptional()
  @IsEnum([PropertyStatus.DRAFT, PropertyStatus.ACTIVE])
  status?: PropertyStatus;
  @ApiPropertyOptional({ description: 'SUPER_ADMIN only: organization to create the property in' })
  @IsOptional()
  @IsMongoId()
  organizationId?: string;
}

/** Currency and time zone are fixed after creation: every stored price and date depends on them. */
export class UpdatePropertyDto extends PartialType(OmitType(CreatePropertyDto, ['currency', 'timezone', 'organizationId'] as const)) {
  @ApiPropertyOptional({ enum: [PropertyStatus.DRAFT, PropertyStatus.ACTIVE, PropertyStatus.INACTIVE] })
  @IsOptional()
  @IsEnum([PropertyStatus.DRAFT, PropertyStatus.ACTIVE, PropertyStatus.INACTIVE])
  declare status?: PropertyStatus;
}

export class PropertyDto {
  @ApiProperty() _id!: string;
  @ApiProperty() organizationId!: string;
  @ApiProperty() ownerId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty() address!: string;
  @ApiProperty() city!: string;
  @ApiProperty() state!: string;
  @ApiProperty() country!: string;
  @ApiProperty() postalCode!: string;
  @ApiPropertyOptional() latitude?: number;
  @ApiPropertyOptional() longitude?: number;
  @ApiProperty() timezone!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() checkInTime!: string;
  @ApiProperty() checkOutTime!: string;
  @ApiProperty() taxPercent!: number;
  @ApiProperty() bookingHorizonDays!: number;
  @ApiProperty({ type: [ImageDto] }) images!: ImageDto[];
  @ApiProperty({ type: [String] }) amenities!: string[];
  @ApiProperty({ enum: PropertyStatus }) status!: PropertyStatus;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
