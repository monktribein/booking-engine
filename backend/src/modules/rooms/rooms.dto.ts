import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsUUID, IsOptional, IsString, Length } from 'class-validator';
import { IsDateOnly } from '../../common/dto';
import { RoomStatus } from '../../database/enums';

export class CreateRoomDto {
  @ApiProperty({ example: '104' }) @IsString() @Length(1, 20) roomNumber!: string;
  @ApiPropertyOptional({ example: '1' }) @IsOptional() @IsString() @Length(1, 20) floor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) notes?: string;
}

export class UpdateRoomDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 20) roomNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 20) floor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) notes?: string;
  @ApiPropertyOptional({ description: 'Move the room to another room type of the same property' })
  @IsOptional()
  @IsUUID()
  roomTypeId?: string;
}

const SETTABLE = [RoomStatus.AVAILABLE, RoomStatus.CLEANING, RoomStatus.MAINTENANCE, RoomStatus.BLOCKED];

export class ChangeRoomStatusDto {
  @ApiProperty({ enum: SETTABLE, description: 'OCCUPIED is set only by check-in' })
  @IsEnum(SETTABLE)
  status!: RoomStatus;
  @ApiPropertyOptional({
    example: '2026-10-08',
    description: 'For MAINTENANCE/BLOCKED: also take the room out of sellable inventory from today until this date (exclusive)',
  })
  @IsOptional()
  @IsDateOnly()
  blockUntil?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) notes?: string;
}

export class RoomDto {
  @ApiProperty() _id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() roomTypeId!: string;
  @ApiProperty() roomNumber!: string;
  @ApiPropertyOptional() floor?: string;
  @ApiProperty({ enum: RoomStatus }) status!: RoomStatus;
  @ApiPropertyOptional() notes?: string;
  @ApiProperty() createdAt!: string;
}
