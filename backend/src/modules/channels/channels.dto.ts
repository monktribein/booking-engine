import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsUUID,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ChannelConnectionStatus, MarkupType } from '../../database/enums';

export class RateMappingInputDto {
  @ApiProperty({ example: 'MOCK-ROOM-DLX-FLEX' }) @IsString() @Length(1, 100) externalRatePlanId!: string;
  @ApiProperty() @IsUUID() ratePlanId!: string;
  @ApiPropertyOptional({ enum: MarkupType, default: MarkupType.NONE }) @IsOptional() @IsEnum(MarkupType) markupType?: MarkupType;
  @ApiPropertyOptional({ description: 'Percent for PERCENTAGE, minor units for FIXED' }) @IsOptional() @IsNumber() markupValue?: number;
}

export class MappingInputDto {
  @ApiProperty({ example: 'MOCK-HOTEL-1' }) @IsString() @Length(1, 100) externalListingId!: string;
  @ApiPropertyOptional({ nullable: true, example: 'MOCK-ROOM-DLX', description: 'Room inside a hotel-style listing; null for single-unit listings' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Length(1, 100)
  externalRoomId?: string | null;
  @ApiProperty({ description: 'Tirvona room type this listing/room sells' }) @IsUUID() roomTypeId!: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() syncAvailability?: boolean;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() syncRates?: boolean;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() syncRestrictions?: boolean;
  @ApiPropertyOptional({ type: [RateMappingInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RateMappingInputDto)
  ratePlans?: RateMappingInputDto[];
}

export class CreateMappingsDto {
  @ApiProperty({ type: [MappingInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MappingInputDto)
  mappings!: MappingInputDto[];
}

export class ChannelStatusDto {
  @ApiProperty() channel!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ description: 'Reads Tirvona inventory directly (TIRVONA, DIRECT)' }) internal!: boolean;
  @ApiProperty({ description: 'Integration usable on this deployment' }) available!: boolean;
  @ApiProperty({ enum: [...Object.values(ChannelConnectionStatus), 'INTERNAL'] }) status!: string;
  @ApiPropertyOptional() connectedAt?: string;
  @ApiPropertyOptional() lastSyncAt?: string;
  @ApiPropertyOptional() lastError?: string;
  @ApiProperty() listings!: number;
  @ApiProperty() mappings!: number;
}

export class ConnectResultDto {
  @ApiProperty({ enum: ChannelConnectionStatus }) status!: ChannelConnectionStatus;
  @ApiPropertyOptional({ description: "Send the owner's browser here to authorize Tirvona on the channel" }) authorizationUrl?: string;
}

export class ListingWithMappingsDto {
  @ApiProperty() _id!: string;
  @ApiProperty() channel!: string;
  @ApiProperty() externalListingId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: [Object], description: 'Rooms and rate plans offered by the listing on the channel' }) externalRooms!: Record<string, unknown>[];
  @ApiProperty({ type: [Object] }) externalRatePlans!: Record<string, unknown>[];
  @ApiProperty({ type: [Object], description: 'Existing mappings (with room type and rate mappings)' }) roomMappings!: Record<string, unknown>[];
}

export class MappingResultDto {
  @ApiProperty() mappingId!: string;
  @ApiProperty() externalListingId!: string;
  @ApiPropertyOptional({ nullable: true }) externalRoomId!: string | null;
  @ApiProperty() roomTypeId!: string;
  @ApiProperty() created!: boolean;
  @ApiProperty() rateMappings!: number;
}

export class SyncTriggerResultDto {
  @ApiProperty({ description: 'Sync jobs queued' }) queued!: number;
}
