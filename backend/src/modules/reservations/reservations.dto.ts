import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsUUID,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly, PropertyScopedPageQueryDto } from '../../common/dto';
import { ReservationPaymentStatus, ReservationSource, ReservationStatus } from '../../database/enums';

export class GuestInputDto {
  @ApiProperty() @IsString() @Length(1, 100) firstName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ example: '+919811111111' }) @IsOptional() @Matches(/^\+[1-9]\d{6,14}$/) phone?: string;
  @ApiPropertyOptional({ example: 'IN' }) @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
}

export class ReservationRoomInputDto {
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiProperty() @IsUUID() ratePlanId!: string;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(20) quantity!: number;
  @ApiPropertyOptional({ type: [Number], description: 'Staff price override, one per night (minor units)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(90)
  @IsInt({ each: true })
  @Min(0, { each: true })
  nightlyRates?: number[];
}

/** Sources staff may use. OTA bookings arrive only through the channel manager. */
export const STAFF_SOURCES = [
  ReservationSource.DIRECT,
  ReservationSource.WALK_IN,
  ReservationSource.PHONE,
  ReservationSource.AGENT,
  ReservationSource.OTHER,
] as const;

export class CreateReservationDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty({ enum: STAFF_SOURCES }) @IsEnum(STAFF_SOURCES) source!: ReservationSource;
  @ApiPropertyOptional({ description: 'Existing guest; otherwise pass `guest`' }) @IsOptional() @IsUUID() guestId?: string;
  @ApiPropertyOptional({ type: GuestInputDto }) @IsOptional() @ValidateNested() @Type(() => GuestInputDto) guest?: GuestInputDto;
  @ApiProperty({ example: '2026-10-05' }) @IsDateOnly() checkIn!: string;
  @ApiProperty({ example: '2026-10-08' }) @IsDateOnly() checkOut!: string;
  @ApiProperty({ example: 2 }) @IsInt() @Min(1) @Max(100) adults!: number;
  @ApiPropertyOptional({ example: 0 }) @IsOptional() @IsInt() @Min(0) @Max(100) children?: number;
  @ApiProperty({ type: [ReservationRoomInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReservationRoomInputDto)
  rooms!: ReservationRoomInputDto[];
  @ApiPropertyOptional({ description: 'Minor units' }) @IsOptional() @IsInt() @Min(0) discount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) specialRequests?: string;
  @ApiPropertyOptional({ enum: [ReservationStatus.PENDING, ReservationStatus.CONFIRMED], default: ReservationStatus.CONFIRMED })
  @IsOptional()
  @IsEnum([ReservationStatus.PENDING, ReservationStatus.CONFIRMED])
  status?: ReservationStatus.PENDING | ReservationStatus.CONFIRMED;
}

export class UpdateReservationDto {
  @ApiPropertyOptional({ description: 'Changing dates re-reserves inventory atomically' }) @IsOptional() @IsDateOnly() checkIn?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateOnly() checkOut?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) adults?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) children?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) specialRequests?: string;
  @ApiPropertyOptional({ type: GuestInputDto }) @IsOptional() @ValidateNested() @Type(() => GuestInputDto) guest?: GuestInputDto;
}

export class CancelReservationDto {
  @ApiProperty({ example: 'Guest request' }) @IsString() @Length(1, 500) reason!: string;
  @ApiPropertyOptional({ description: 'Override the policy refund (minor units). Needs payments:refund.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  refundAmount?: number;
}

export class RoomAssignmentDto {
  @ApiProperty() @IsUUID() reservationRoomId!: string;
  @ApiProperty() @IsUUID() roomId!: string;
}

export class CheckInDto {
  @ApiPropertyOptional({ type: [RoomAssignmentDto], description: 'Assign rooms at check-in' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RoomAssignmentDto)
  assignments?: RoomAssignmentDto[];
}

export class ReservationListQueryDto extends PropertyScopedPageQueryDto {
  @ApiPropertyOptional({ enum: ReservationStatus }) @IsOptional() @IsEnum(ReservationStatus) status?: ReservationStatus;
  @ApiPropertyOptional({ description: 'Booking source: a built-in one (DIRECT, AIRBNB, ...) or the code of a configured provider (ACME_STAY, ICAL, CSV_IMPORT)', example: 'DIRECT' })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,31}$/, { message: 'source must be a provider code in capital letters' })
  source?: string;
  @ApiPropertyOptional({ description: 'Stays overlapping [from, to)' }) @IsOptional() @IsDateOnly() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateOnly() to?: string;
  @ApiPropertyOptional({ description: 'Reservation code, external id or guest name' }) @IsOptional() @IsString() @Length(1, 100) q?: string;
}

// ------------------------------------------------------------------ responses

class NightlyRateDto {
  @ApiProperty() date!: string;
  @ApiProperty() amount!: number;
}

class ReservationRoomDto {
  @ApiProperty() _id!: string;
  @ApiProperty() roomTypeId!: string;
  @ApiProperty() roomTypeName!: string;
  @ApiPropertyOptional({ nullable: true }) roomId!: string | null;
  @ApiPropertyOptional({ nullable: true }) roomNumber!: string | null;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional({ nullable: true }) ratePlanId!: string | null;
  @ApiPropertyOptional({ type: Object, nullable: true, description: 'Rate plan as sold (frozen)' }) ratePlan!: Record<string, unknown> | null;
  @ApiProperty({ type: [NightlyRateDto] }) nightlyRates!: NightlyRateDto[];
  @ApiProperty() subtotal!: number;
  @ApiProperty() tax!: number;
  @ApiProperty() total!: number;
}

export class ReservationDto {
  @ApiProperty() _id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty({ example: 'TRV-7K3M9QXD' }) reservationCode!: string;
  @ApiProperty({ enum: ReservationSource }) source!: ReservationSource;
  @ApiPropertyOptional() externalReservationId?: string;
  @ApiProperty({ enum: ReservationStatus }) status!: ReservationStatus;
  @ApiProperty() guestId!: string;
  @ApiProperty({ type: GuestInputDto }) guest!: GuestInputDto;
  @ApiProperty() checkIn!: string;
  @ApiProperty() checkOut!: string;
  @ApiProperty() nights!: number;
  @ApiProperty() adults!: number;
  @ApiProperty() children!: number;
  @ApiPropertyOptional() specialRequests?: string;
  @ApiProperty({ type: [ReservationRoomDto] }) reservationRooms!: ReservationRoomDto[];
  @ApiProperty() subtotal!: number;
  @ApiProperty() tax!: number;
  @ApiProperty() discount!: number;
  @ApiProperty() total!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() amountPaid!: number;
  @ApiProperty() amountRefunded!: number;
  @ApiProperty({ enum: ReservationPaymentStatus }) paymentStatus!: ReservationPaymentStatus;
  @ApiPropertyOptional({ nullable: true }) holdExpiresAt!: string | null;
  @ApiProperty() overbooked!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CancelResultDto {
  @ApiProperty({ type: ReservationDto }) reservation!: ReservationDto;
  @ApiProperty({ type: [Object], description: 'Refunds queued under the cancellation policy' }) refunds!: Record<string, unknown>[];
  @ApiProperty() alreadyCancelled!: boolean;
}

export class CheckOutResultDto {
  @ApiProperty({ type: ReservationDto }) reservation!: ReservationDto;
  @ApiProperty({ description: 'Outstanding amount, minor units' }) balanceDue!: number;
}
